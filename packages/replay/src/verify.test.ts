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

/**
 * Posições de bola na mão para os testes.
 *
 * Sem elas a verificação PARA na primeira falta, e está certa em parar: a
 * posição escolhida pelo jogador é entrada, e inventar um ponto canônico faria
 * o replay reproduzir uma partida que ninguém jogou. Os testes que só querem
 * chegar a um vencedor precisam fornecê-las.
 */
const POSICOES = Array.from({ length: 20 }, () => ({ x: 0.495, y: 0.495 }))

const replay = (shots: Replay['shots'], placements = POSICOES): Replay => ({
  version: REPLAY_VERSION,
  mode: 'eightball',
  engineVersion: ENGINE_VERSION,
  seed,
  cues: [DEFAULT_CUE, DEFAULT_CUE],
  shots,
  decisions: [],
  placements,
  // A regra padrão exige declarar a caçapa na bola 8. Sem isto, a verificação
  // para justamente na tacada que decide a partida.
  calls: Array.from({ length: 8 }, () => ({ ball: 8, pocket: 0 })),
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

describe('bola na mão', () => {
  test('sem a posição gravada, a verificação para em vez de inventar', () => {
    // Este é o buraco que o formato v4 fechou. Antes, a verificação usava o
    // ponto de saque canônico e seguia — reproduzindo uma partida diferente da
    // que foi jogada, e podendo apontar outro vencedor sem nada acusar.
    const muitas = Array.from({ length: 40 }, (_, i) => tacada((i * 53) % 360, 0.9))
    const semPosicoes = verifyReplay(replay(muitas, []))
    const comPosicoes = verifyReplay(replay(muitas))

    expect(semPosicoes.shotsApplied).toBeLessThan(comPosicoes.shotsApplied)
    expect(semPosicoes.stoppedBecause).toContain('bola na mão')
  })

  test('a posição muda o resultado — por isso ela vai gravada', () => {
    const muitas = Array.from({ length: 30 }, (_, i) => tacada((i * 53) % 360, 0.9))

    const a = verifyReplay(replay(muitas, POSICOES))
    const b = verifyReplay(
      replay(
        muitas,
        POSICOES.map(() => ({ x: 1.4, y: 0.3 })),
      ),
    )

    expect(a.stateHash).not.toBe(b.stateHash)
  })

  test('a posição sobrevive à ida e volta pelos bytes', () => {
    const r = replay([tacada(0, 1)], [{ x: 1.23, y: 0.45 }])
    const volta = decodeReplay(encodeReplay(r))

    // Quantizada em u16 sobre a mesa: 0,03 mm de resolução.
    expect(volta.placements[0]!.x).toBeCloseTo(1.23, 4)
    expect(volta.placements[0]!.y).toBeCloseTo(0.45, 4)
  })
})

describe('a verificação é invariante à origem do replay', () => {
  test('posição não quantizada dá o mesmo resultado que a gravada', () => {
    // Um `Replay` montado à mão pode trazer posições com precisão total; o
    // encode as quantiza. Se a verificação em memória usasse as originais e a
    // dos bytes as quantizadas, as duas apontariam vencedores diferentes — e
    // foi assim que a prova contra a devnet falhou.
    const shots = Array.from({ length: 30 }, (_, i) => tacada((i * 53) % 360, 0.9))
    const bruto = replay(
      shots,
      Array.from({ length: 20 }, (_, i) => ({ x: 0.4 + i / 37, y: 0.2 + i / 53 })),
    )

    const emMemoria = verifyReplay(bruto)
    const daChain = verifyReplay(decodeReplay(encodeReplay(bruto)))

    expect(daChain.stateHash).toBe(emMemoria.stateHash)
    expect(daChain.winner).toBe(emMemoria.winner)
  })
})

describe('replays antigos continuam auditáveis', () => {
  /**
   * Sem isto, "auditável para sempre" vale só até a próxima mudança de
   * formato. Foram duas num dia, e elas órfãs todo o histórico já gravado na
   * blockchain — que é permanente e não pode ser regravado.
   *
   * Reproduzir um replay antigo exige as SEMÂNTICAS da época, não só o layout:
   * o v4 não tem caçapa declarada porque o jogo daquele momento não declarava,
   * e as regras julgavam com `called = null`.
   */
  const shots = Array.from({ length: 12 }, (_, i) => tacada((i * 53) % 360, 0.9))

  /** Reescreve um replay atual no layout de uma versão anterior. */
  function comoVersao(bytes: Uint8Array, versao: 3 | 4): Uint8Array {
    const copia = Uint8Array.from(bytes)
    copia[0] = versao
    if (versao === 4) {
      copia[59] = 0 // no v4 o byte de declarações era reservado
      return copia.slice(0, copia.length - contarDeclaracoes(bytes) * 2)
    }
    return copia
  }

  const contarDeclaracoes = (bytes: Uint8Array): number => bytes[59] ?? 0

  test('o v4 é lido e verificado', () => {
    const atual = encodeReplay(replay(shots, []))
    const antigo = decodeReplay(comoVersao(atual, 4))

    expect(antigo.version).toBe(4)
    expect(() => verifyReplay(antigo)).not.toThrow()
  })

  test('o v4 não exige caçapa declarada, porque não a gravava', () => {
    // Exigir declaração num replay que nunca a teve pararia a verificação
    // justamente na tacada que decide a partida.
    const atual = encodeReplay(replay(shots, POSICOES))
    const antigo = decodeReplay(comoVersao(atual, 4))

    // `stoppedBecause` é null quando nada interrompeu, então a checagem
    // precisa aceitar os dois casos.
    expect(verifyReplay(antigo).stoppedBecause ?? '').not.toContain('caçapa')
  })

  test('versão desconhecida continua sendo recusada, não adivinhada', () => {
    const bytes = encodeReplay(replay([tacada(0, 1)]))
    bytes[0] = 99

    expect(() => decodeReplay(bytes)).toThrow(/não suportada/)
  })

  test('a mensagem diz quais versões este código lê', () => {
    const bytes = encodeReplay(replay([tacada(0, 1)]))
    bytes[0] = 99

    expect(() => decodeReplay(bytes)).toThrow(/3, 4, 5/)
  })
})
