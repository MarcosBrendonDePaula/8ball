import { describe, expect, test } from 'bun:test'
import { DISCONNECT_GRACE_MS, MatchRuleError, SHOT_CLOCK_MS, commitOf } from '@/match'
import { Matches, type MatchEvent } from '@/matches'
import { encodeAngle, encodePower } from '@zinc-pool/replay'

/**
 * O registro é o único lugar que lê o relógio de verdade, então aqui ele é
 * substituído por uma variável. Nenhum teste espera.
 */

const ALICE = 'Alice1111111111111111111111111111111111111'
const BOB = 'Bob22222222222222222222222222222222222222'
const MATCH = 'a'.repeat(32)

const nonceA = Uint8Array.from({ length: 32 }, (_, i) => i)
const nonceB = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)

function ambiente() {
  let agora = 1_000_000
  const eventos: MatchEvent[] = []
  const matches = new Matches(() => agora)
  matches.subscribe((e) => eventos.push(e))

  return {
    matches,
    eventos,
    tipos: () => eventos.map((e) => e.t),
    avancar(ms: number) {
      agora += ms
      matches.tick()
    },
    em(ms: number) {
      agora += ms
    },
  }
}

/** Partida aberta, com os dois comprometidos e revelados. */
function jogando() {
  const env = ambiente()
  env.matches.open(MATCH, 'eightball', [ALICE, BOB])
  env.matches.commit(ALICE, commitOf(nonceA))
  env.matches.commit(BOB, commitOf(nonceB))
  env.matches.reveal(ALICE, nonceA)
  env.matches.reveal(BOB, nonceB)
  return env
}

const tacada = (graus: number, forca: number) => ({
  angle: encodeAngle((graus * Math.PI) / 180),
  power: encodePower(forca),
  spinX: 0,
  spinY: 0,
})

const daVez = (env: ReturnType<typeof jogando>): string => {
  const m = env.matches.matchOf(ALICE)!.match
  return m.players[m.turn!].address
}

describe('ciclo de vida', () => {
  test('a partida só nasce com os dois compromissos', () => {
    const env = ambiente()
    env.matches.open(MATCH, 'eightball', [ALICE, BOB])

    expect(env.tipos()).toEqual(['begin'])
    expect(env.matches.get(MATCH)).toBeUndefined()

    env.matches.commit(ALICE, commitOf(nonceA))
    expect(env.matches.get(MATCH)).toBeUndefined()

    env.matches.commit(BOB, commitOf(nonceB))
    expect(env.matches.get(MATCH)).toBeDefined()
    expect(env.tipos()).toContain('revealOpen')
  })

  test('ninguém se compromete duas vezes', () => {
    const env = ambiente()
    env.matches.open(MATCH, 'eightball', [ALICE, BOB])
    env.matches.commit(ALICE, commitOf(nonceA))

    expect(() => env.matches.commit(ALICE, commitOf(nonceB))).toThrow(MatchRuleError)
  })

  test('quem não está em partida nenhuma é recusado', () => {
    const env = ambiente()
    expect(() => env.matches.shoot('Carol', tacada(0, 0.5))).toThrow(/não está em nenhuma partida/)
  })

  test('a revelação dos dois emite o seed da quebra', () => {
    const env = jogando()
    const start = env.eventos.find((e) => e.t === 'start')

    expect(start).toBeDefined()
    expect((start as { seed: Uint8Array }).seed).toHaveLength(32)
  })

  test('a partida some do registro quando acaba', () => {
    const env = jogando()
    expect(env.matches.active).toBe(1)

    env.matches.forfeit(ALICE)

    expect(env.matches.active).toBe(0)
    expect(env.matches.matchOf(ALICE)).toBeNull()
    expect(env.matches.matchOf(BOB)).toBeNull()
    expect(env.tipos()).toContain('end')
  })
})

describe('tacadas pela rede', () => {
  test('a tacada válida vira evento com o hash do estado', () => {
    const env = jogando()
    env.matches.shoot(daVez(env), tacada(180, 0.9))

    const shot = env.eventos.find((e) => e.t === 'shot')
    expect(shot).toBeDefined()
    expect((shot as { view: { stateHash: string } }).view.stateHash).toHaveLength(8)
  })

  test('tacada fora da vez não muda nada', () => {
    const env = jogando()
    const m = env.matches.matchOf(ALICE)!.match
    const errado = m.players[m.turn === 0 ? 1 : 0].address

    expect(() => env.matches.shoot(errado, tacada(180, 0.9))).toThrow(/Não é a sua vez/)
    expect(env.tipos()).not.toContain('shot')
  })
})

describe('prazos disparam sozinhos', () => {
  test('o relógio corre e a falta acontece sem ninguém pedir', () => {
    const env = jogando()
    const antes = env.matches.matchOf(ALICE)!.match.recorder!.shotCount

    env.avancar(SHOT_CLOCK_MS)

    expect(env.matches.matchOf(ALICE)!.match.recorder!.shotCount).toBe(antes + 1)
  })

  test('W.O. por tempo encerra e limpa o registro', () => {
    const env = jogando()

    for (let i = 0; i < 12 && env.matches.active > 0; i++) env.avancar(SHOT_CLOCK_MS)

    expect(env.matches.active).toBe(0)
    const fim = env.eventos.find((e) => e.t === 'end')
    expect((fim as { result: { reason: string } }).result.reason).toBe('tempo')
  })

  test('desconexão longa termina em abandono', () => {
    const env = jogando()
    env.matches.markOffline(BOB)

    env.avancar(DISCONNECT_GRACE_MS)

    const fim = env.eventos.find((e) => e.t === 'end')
    expect((fim as { result: { reason: string; winner: number } }).result.reason).toBe('abandono')
    expect((fim as { result: { winner: number } }).result.winner).toBe(0)
  })

  test('reconectar cancela a contagem', () => {
    const env = jogando()
    env.matches.markOffline(BOB)
    env.em(DISCONNECT_GRACE_MS - 1)
    env.matches.markOnline(BOB)

    env.avancar(DISCONNECT_GRACE_MS)

    const fim = env.eventos.find((e) => e.t === 'end')
    expect((fim as { result: { reason: string } } | undefined)?.result.reason).not.toBe('abandono')
  })
})

describe('o resultado sai pronto para liquidar', () => {
  test('o fim carrega os bytes do replay', () => {
    const env = jogando()
    env.matches.shoot(daVez(env), tacada(180, 0.9))
    env.matches.forfeit(ALICE)

    const fim = env.eventos.find((e) => e.t === 'end') as { result: { replay: Uint8Array } }
    // Cabeçalho de 58 mais uma tacada de 5.
    expect(fim.result.replay.length).toBe(63)
  })

  test('o painel enxerga a partida em andamento', () => {
    const env = jogando()
    const lista = env.matches.list()

    expect(lista).toHaveLength(1)
    expect(lista[0]!.players).toEqual([ALICE, BOB])
    expect(lista[0]!.mode).toBe('eightball')
  })
})

describe('reabrir não pode apagar o que já foi feito', () => {
  test('abrir a mesma partida duas vezes é ignorado', () => {
    const env = ambiente()
    env.matches.open(MATCH, 'eightball', [ALICE, BOB])
    env.matches.commit(ALICE, commitOf(nonceA))

    // Segunda autenticação do mesmo jogador chamaria isto de novo. Se
    // reabrisse, o compromisso da Alice sumiria e os dois ficariam presos até
    // o prazo da revelação.
    env.matches.open(MATCH, 'eightball', [ALICE, BOB])
    env.matches.commit(BOB, commitOf(nonceB))

    expect(env.matches.get(MATCH)).toBeDefined()
  })

  test('has enxerga a partida ainda pendente', () => {
    const env = ambiente()
    expect(env.matches.has(MATCH)).toBe(false)

    env.matches.open(MATCH, 'eightball', [ALICE, BOB])

    // `get` ainda devolve undefined aqui; é exatamente essa diferença que
    // levaria a reabrir.
    expect(env.matches.get(MATCH)).toBeUndefined()
    expect(env.matches.has(MATCH)).toBe(true)
  })
})

describe('reconectar reencontra a partida', () => {
  test('devolve o índice e os jogadores antes de a partida nascer', () => {
    const env = ambiente()
    env.matches.open(MATCH, 'eightball', [ALICE, BOB])

    const r = env.matches.resume(BOB)
    expect(r?.you).toBe(1)
    expect(r?.match).toBeNull()
    expect(r?.players).toEqual([ALICE, BOB])
  })

  test('devolve a partida viva depois de começar', () => {
    const env = jogando()
    const r = env.matches.resume(ALICE)

    expect(r?.you).toBe(0)
    expect(r?.match).not.toBeNull()
    expect(r?.match?.recorder?.seed).toHaveLength(32)
  })

  test('quem não está em partida nenhuma não reencontra nada', () => {
    expect(ambiente().matches.resume('Carol')).toBeNull()
  })
})
