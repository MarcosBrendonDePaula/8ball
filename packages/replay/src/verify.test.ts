import { describe, expect, test } from 'bun:test'
import {
  CUE_ARCHETYPES,
  DEFAULT_CUE,
  ENGINE_VERSION,
  PHYSICS_DIGEST,
  fixturesDigest,
} from '@zinc-pool/engine-physics'
import {
  REPLAY_VERSION,
  decodeReplay,
  encodeAngle,
  encodePower,
  encodeReplay,
  type Replay,
} from './format'
import { checkEngineCompatibility, replayProves, verifyReplay } from './verify'

/**
 * A verificação é o que sustenta a promessa de auditoria: qualquer pessoa
 * pega os bytes da blockchain, roda isto, e confere que o vencedor declarado
 * é o correto. Se ela puder ser enganada, a promessa é falsa.
 */

const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256)

const tacada = (grausDoAngulo: number, forca: number) => ({
  angle: encodeAngle((grausDoAngulo * Math.PI) / 180),
  power: encodePower(forca),
  spinX: 0,
  spinY: 0,
})

const replay = (shots: Replay['shots']): Replay => ({
  version: REPLAY_VERSION,
  mode: 'eightball',
  engineVersion: ENGINE_VERSION,
  seed,
  cues: [DEFAULT_CUE, DEFAULT_CUE],
  shots,
})

describe('reprodução', () => {
  test('um replay vazio não produz vencedor', () => {
    const r = verifyReplay(replay([]))
    expect(r.winner).toBeNull()
    expect(r.shotsApplied).toBe(0)
  })

  test('aplica todas as tacadas', () => {
    const r = verifyReplay(replay([tacada(0, 1), tacada(30, 0.6), tacada(200, 0.8)]))
    expect(r.shotsApplied).toBe(3)
  })

  test('verificar duas vezes dá exatamente o mesmo resultado', () => {
    // Se não desse, a auditoria não provaria nada.
    const r = replay([tacada(0, 1), tacada(45, 0.7), tacada(120, 0.5)])
    const a = verifyReplay(r)
    const b = verifyReplay(r)

    expect(a.stateHash).toBe(b.stateHash)
    expect([...a.replayHash]).toEqual([...b.replayHash])
    expect(a.winner).toBe(b.winner)
  })

  test('mudar uma tacada muda o resultado', () => {
    const a = verifyReplay(replay([tacada(0, 1), tacada(45, 0.7)]))
    const b = verifyReplay(replay([tacada(0, 1), tacada(46, 0.7)]))

    expect(a.stateHash).not.toBe(b.stateHash)
  })

  test('mudar o seed muda o resultado', () => {
    const outro = Uint8Array.from({ length: 32 }, () => 200)
    const a = verifyReplay(replay([tacada(0, 1)]))
    const b = verifyReplay({ ...replay([tacada(0, 1)]), seed: outro })

    expect(a.stateHash).not.toBe(b.stateHash)
  })

  test('mudar o taco muda o resultado — por isso ele vai gravado', () => {
    const a = verifyReplay(replay([tacada(0, 1)]))
    const b = verifyReplay({
      ...replay([tacada(0, 1)]),
      cues: [CUE_ARCHETYPES.pesado, DEFAULT_CUE],
    })

    expect(a.stateHash).not.toBe(b.stateHash)
  })

  test('o hash do replay é o SHA-256 dos bytes gravados', () => {
    const r = replay([tacada(10, 0.9)])
    const verificado = verifyReplay(r)

    expect(verificado.replayHash).toHaveLength(32)
    // O mesmo replay, os mesmos bytes, o mesmo hash.
    expect([...verifyReplay({ ...r }).replayHash]).toEqual([...verificado.replayHash])
  })

  test('para de aplicar quando a partida termina', () => {
    // Tacadas depois do fim são ignoradas, não alteram o vencedor.
    const muitas = Array.from({ length: 40 }, (_, i) => tacada(i * 9, 0.85))
    const r = verifyReplay(replay(muitas))

    if (r.winner !== null) {
      expect(r.shotsApplied).toBeLessThanOrEqual(muitas.length)
      expect(r.stoppedBecause).toBe('a partida já havia terminado')
    }
  })

  test('funciona para a sinuca também', () => {
    const r = verifyReplay({ ...replay([tacada(0, 1), tacada(20, 0.5)]), mode: 'sinuca' })
    expect(r.shotsApplied).toBe(2)
    expect(r.stateHash).toHaveLength(8)
  })
})

describe('prova contra o declarado on-chain', () => {
  /** Encontra um replay que chegue a um vencedor, para os testes de prova. */
  function replayComVencedor(): { r: Replay; winner: 0 | 1 } {
    for (let semente = 0; semente < 40; semente++) {
      const shots = Array.from({ length: 60 }, (_, i) => tacada((semente * 13 + i * 27) % 360, 0.9))
      const r = replay(shots)
      const v = verifyReplay(r)
      if (v.winner !== null) return { r, winner: v.winner }
    }
    throw new Error('Nenhum replay de teste chegou a um vencedor.')
  }

  test('replay coerente com o declarado é aceito', () => {
    const { r, winner } = replayComVencedor()
    const { replayHash } = verifyReplay(r)

    expect(replayProves(r, { winner, resultHash: replayHash })).toEqual({
      valid: true,
      reason: null,
    })
  })

  test('vencedor declarado errado é recusado', () => {
    // É este teste que garante que o servidor não pode mentir.
    const { r, winner } = replayComVencedor()
    const { replayHash } = verifyReplay(r)
    const mentira = (winner === 0 ? 1 : 0) as 0 | 1

    const resultado = replayProves(r, { winner: mentira, resultHash: replayHash })
    expect(resultado.valid).toBe(false)
    expect(resultado.reason).toContain('replay dá vitória')
  })

  test('hash adulterado é recusado', () => {
    const { r, winner } = replayComVencedor()
    const hashErrado = new Uint8Array(32).fill(9)

    const resultado = replayProves(r, { winner, resultHash: hashErrado })
    expect(resultado.valid).toBe(false)
    expect(resultado.reason).toContain('hash')
  })

  test('replay sem vencedor não prova nada', () => {
    const r = replay([tacada(0, 0.4)])
    const resultado = replayProves(r, { winner: 0, resultHash: verifyReplay(r).replayHash })

    expect(resultado.valid).toBe(false)
    expect(resultado.reason).toContain('não chega a um vencedor')
  })

  test('trocar um byte do replay invalida a prova', () => {
    const { r, winner } = replayComVencedor()
    const hashOriginal = verifyReplay(r).replayHash

    const adulterado: Replay = {
      ...r,
      shots: r.shots.map((s, i) => (i === 1 ? { ...s, power: s.power ^ 1 } : s)),
    }

    expect(replayProves(adulterado, { winner, resultHash: hashOriginal }).valid).toBe(false)
  })
})

describe('compatibilidade da engine', () => {
  test('esta engine é compatível consigo mesma', () => {
    const r = checkEngineCompatibility(ENGINE_VERSION)
    expect(r.compatible).toBe(true)
    expect(r.reason).toBeNull()
  })

  test('recusa replay de física diferente', () => {
    // Reproduzir com a física errada apontaria outro vencedor — em silêncio.
    const r = checkEngineCompatibility(ENGINE_VERSION + 1)
    expect(r.compatible).toBe(false)
    expect(r.reason).toContain('física')
  })

  test('verifyReplay recusa versão incompatível em vez de tentar', () => {
    const r: Replay = { ...replay([tacada(0, 1)]), engineVersion: 99 }
    expect(() => verifyReplay(r)).toThrow()
  })

  test('a impressão digital declarada bate com a física real', () => {
    // É o que pega uma cópia adulterada da engine que manteve o número da
    // versão: os números batem, o comportamento não.
    expect(fixturesDigest()).toBe(PHYSICS_DIGEST)
  })

  test('a versão viaja dentro do replay', () => {
    const bytes = encodeReplay(replay([tacada(0, 1)]))
    expect(decodeReplay(bytes).engineVersion).toBe(ENGINE_VERSION)
  })
})
