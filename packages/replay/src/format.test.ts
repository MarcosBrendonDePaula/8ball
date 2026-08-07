import { describe, expect, test } from 'bun:test'
import { DEFAULT_CUE, CUE_ARCHETYPES, ENGINE_VERSION } from '@zinc-pool/engine-physics'
import {
  HEADER_SIZE,
  MAX_DECISIONS,
  MAX_REPLAY_BYTES,
  MAX_SHOTS,
  REPLAY_VERSION,
  ReplayFormatError,
  SHOT_SIZE,
  TX_REPLAY_BUDGET,
  decodeAngle,
  decodePower,
  decodeReplay,
  decodeSpin,
  encodeAngle,
  encodePower,
  encodeReplay,
  encodeSpin,
  replaySize,
  type Replay,
} from './format'

/**
 * O formato é o que torna a partida auditável para sempre. Se ele quebrar,
 * replays gravados na blockchain viram bytes sem sentido — e não há como
 * regravá-los.
 */

const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)

const replayBase = (shots: Replay['shots'] = [], decisions: number[] = []): Replay => ({
  version: REPLAY_VERSION,
  mode: 'eightball',
  engineVersion: ENGINE_VERSION,
  seed,
  cues: [DEFAULT_CUE, CUE_ARCHETYPES.pesado],
  shots,
  decisions,
})

const tacada = (over: Partial<Replay['shots'][number]> = {}) => ({
  angle: 12_345,
  power: 200,
  spinX: -40,
  spinY: 60,
  ...over,
})

describe('quantização', () => {
  test('ângulo: ida e volta dentro da resolução', () => {
    for (const graus of [0, 45, 90, 180, 270, 359.9]) {
      const rad = (graus * Math.PI) / 180
      const volta = decodeAngle(encodeAngle(rad))
      const erro = Math.abs(volta - rad)
      // Meio passo de 65536 divisões.
      expect(Math.min(erro, Math.PI * 2 - erro)).toBeLessThan((Math.PI * 2) / 65536)
    }
  })

  test('ângulo envolve a volta em vez de estourar', () => {
    expect(encodeAngle(Math.PI * 4)).toBe(encodeAngle(0))
    expect(encodeAngle(-Math.PI / 2)).toBe(encodeAngle((Math.PI * 3) / 2))
    for (const rad of [-100, 100, 1e6]) {
      const v = encodeAngle(rad)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(65536)
    }
  })

  test('força: 256 níveis, presos em 0..1', () => {
    expect(encodePower(0)).toBe(0)
    expect(encodePower(1)).toBe(255)
    expect(encodePower(5)).toBe(255)
    expect(encodePower(-3)).toBe(0)
    expect(decodePower(encodePower(0.5))).toBeCloseTo(0.5, 2)
  })

  test('efeito: presos em -1..1', () => {
    expect(encodeSpin(1)).toBe(127)
    expect(encodeSpin(-1)).toBe(-127)
    expect(encodeSpin(99)).toBe(127)
    expect(decodeSpin(encodeSpin(-0.5))).toBeCloseTo(-0.5, 2)
  })

  test('quantizar de novo não muda nada', () => {
    // Idempotência: reprocessar um replay não altera as tacadas.
    for (const graus of [37.3, 180.1, 299.99]) {
      const uma = encodeAngle((graus * Math.PI) / 180)
      expect(encodeAngle(decodeAngle(uma))).toBe(uma)
    }
  })
})

describe('serialização', () => {
  test('ida e volta preserva tudo', () => {
    const original = replayBase([tacada(), tacada({ angle: 0, power: 0, spinX: 0, spinY: 0 })])
    const volta = decodeReplay(encodeReplay(original))

    expect(volta.version).toBe(original.version)
    expect(volta.mode).toBe(original.mode)
    expect([...volta.seed]).toEqual([...original.seed])
    expect(volta.cues).toEqual(original.cues)
    expect(volta.shots).toEqual(original.shots)
  })

  test('as duas modalidades sobrevivem à ida e volta', () => {
    for (const mode of ['eightball', 'sinuca'] as const) {
      expect(decodeReplay(encodeReplay({ ...replayBase([tacada()]), mode })).mode).toBe(mode)
    }
  })

  test('replay vazio é válido', () => {
    const volta = decodeReplay(encodeReplay(replayBase()))
    expect(volta.shots).toEqual([])
  })

  test('o tamanho bate com a fórmula', () => {
    for (const n of [0, 1, 10, 60]) {
      const bytes = encodeReplay(replayBase(Array.from({ length: n }, () => tacada())))
      expect(bytes.length).toBe(replaySize(n))
      expect(bytes.length).toBe(HEADER_SIZE + n * SHOT_SIZE)
    }
  })

  test('uma partida realista cabe numa transação', () => {
    const partidaLonga = encodeReplay(replayBase(Array.from({ length: 60 }, () => tacada())))
    expect(partidaLonga.length).toBeLessThan(TX_REPLAY_BUDGET)
  })

  test('o teto do formato cabe no orçamento medido da transação', () => {
    // Este é o teste que faltava. O limite não é "~900 bytes de dados": é a
    // transação inteira em 1232, da qual o settle_match já gasta 510. Um teto
    // acima disso só quebraria em partidas longas, em produção.
    expect(MAX_REPLAY_BYTES).toBeLessThanOrEqual(TX_REPLAY_BUDGET)
  })
})

describe('recusa entrada inválida', () => {
  test('seed com tamanho errado', () => {
    expect(() => encodeReplay({ ...replayBase(), seed: new Uint8Array(16) })).toThrow(
      ReplayFormatError,
    )
  })

  test('tacadas acima do teto', () => {
    const demais = Array.from({ length: MAX_SHOTS + 1 }, () => tacada())
    expect(() => encodeReplay(replayBase(demais))).toThrow(ReplayFormatError)
  })

  test('bytes truncados', () => {
    expect(() => decodeReplay(new Uint8Array(10))).toThrow(ReplayFormatError)
  })

  test('versão desconhecida é recusada, não interpretada', () => {
    // Campos de outra versão podem significar outra coisa; adivinhar
    // produziria um replay errado que parece certo.
    const bytes = encodeReplay(replayBase([tacada()]))
    bytes[0] = 99
    expect(() => decodeReplay(bytes)).toThrow(ReplayFormatError)
  })

  test('modalidade desconhecida é recusada', () => {
    const bytes = encodeReplay(replayBase([tacada()]))
    bytes[1] = 42
    expect(() => decodeReplay(bytes)).toThrow(ReplayFormatError)
  })

  test('contagem de tacadas que não bate com o tamanho', () => {
    const bytes = encodeReplay(replayBase([tacada(), tacada()]))
    new DataView(bytes.buffer).setUint16(56, 99, true)
    expect(() => decodeReplay(bytes)).toThrow(ReplayFormatError)
  })
})

describe('estabilidade do formato', () => {
  test('os mesmos dados produzem sempre os mesmos bytes', () => {
    const r = replayBase([tacada(), tacada({ angle: 500 })])
    expect([...encodeReplay(r)]).toEqual([...encodeReplay(r)])
  })

  test('um bit diferente muda os bytes', () => {
    const a = encodeReplay(replayBase([tacada()]))
    const b = encodeReplay(replayBase([tacada({ power: 201 })]))
    expect([...a]).not.toEqual([...b])
  })

  test('o taco de cada jogador é gravado separado', () => {
    const r = replayBase([tacada()])
    const volta = decodeReplay(encodeReplay(r))

    expect(volta.cues[0]).toEqual(DEFAULT_CUE)
    expect(volta.cues[1]).toEqual(CUE_ARCHETYPES.pesado)
    expect(volta.cues[0]).not.toEqual(volta.cues[1])
  })
})

describe('decisões', () => {
  test('atravessam a serialização na ordem', () => {
    const r = replayBase([tacada(), tacada({ angle: 900 })], [3, 0, 1])
    expect(decodeReplay(encodeReplay(r)).decisions).toEqual([3, 0, 1])
  })

  test('partida sem decisões não gasta byte nenhum', () => {
    const semNada = encodeReplay(replayBase([tacada()], []))
    expect(semNada.length).toBe(replaySize(1))
  })

  test('cada decisão custa exatamente um byte', () => {
    const uma = encodeReplay(replayBase([tacada()], [2]))
    expect(uma.length).toBe(replaySize(1, 1))
  })

  test('o replay cheio cabe no limite gravável on-chain', () => {
    // Casado com MAX_REPLAY_BYTES do programa em Rust. Se este teste falhar,
    // a liquidação de partidas longas passa a ser rejeitada pela blockchain.
    expect(replaySize(MAX_SHOTS, MAX_DECISIONS)).toBe(MAX_REPLAY_BYTES)
  })

  test('recusa mais decisões do que cabe', () => {
    const demais = Array.from({ length: MAX_DECISIONS + 1 }, () => 0)
    expect(() => encodeReplay(replayBase([tacada()], demais))).toThrow(ReplayFormatError)
  })

  test('recusa índice que não cabe num byte', () => {
    expect(() => encodeReplay(replayBase([tacada()], [300]))).toThrow(ReplayFormatError)
  })

  test('bytes truncados no fim das decisões são recusados', () => {
    const bytes = encodeReplay(replayBase([tacada()], [1, 2]))
    expect(() => decodeReplay(bytes.slice(0, bytes.length - 1))).toThrow(ReplayFormatError)
  })
})
