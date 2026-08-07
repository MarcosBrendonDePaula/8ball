import { describe, expect, test } from 'bun:test'
import {
  DISCONNECT_GRACE_MS,
  MAX_SHOT_CLOCK_FOULS,
  Match,
  MatchRuleError,
  REVEAL_TIMEOUT_MS,
  SHOT_CLOCK_MS,
  commitOf,
  seedFromNonces,
} from '@/match'
import { DEFAULT_CUE, CUE_ARCHETYPES } from '@zinc-pool/engine-physics'
import { decodeReplay, encodeAngle, encodePower, verifyReplay } from '@zinc-pool/replay'

/**
 * O relógio é injetado, então nada aqui espera de verdade.
 *
 * Prazo de tacada, W.O. e abandono são as regras mais fáceis de implementar
 * com um `setTimeout` que ninguém consegue testar. Com o tempo como parâmetro,
 * avançar duas horas é uma linha — e um bug de contagem aparece na hora.
 */

const ALICE = 'Alice1111111111111111111111111111111111111'
const BOB = 'Bob22222222222222222222222222222222222222'

const nonceA = Uint8Array.from({ length: 32 }, (_, i) => i)
const nonceB = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)

const T0 = 1_000_000

function novaPartida(modo: 'eightball' | 'sinuca' = 'eightball'): Match {
  return new Match(
    modo,
    [
      { address: ALICE, cue: DEFAULT_CUE },
      { address: BOB, cue: CUE_ARCHETYPES.pesado },
    ],
    [commitOf(nonceA), commitOf(nonceB)],
    T0,
  )
}

/** Partida já com a quebra definida, pronta para a primeira tacada. */
function partidaIniciada(modo: 'eightball' | 'sinuca' = 'eightball'): Match {
  const m = novaPartida(modo)
  m.reveal(ALICE, nonceA, T0)
  m.reveal(BOB, nonceB, T0)
  return m
}

const tacada = (graus: number, forca: number) => ({
  angle: encodeAngle((graus * Math.PI) / 180),
  power: encodePower(forca),
  spinX: 0,
  spinY: 0,
})

const enderecoDaVez = (m: Match): string => m.players[m.turn!].address

describe('commit-reveal define a quebra', () => {
  test('a partida não começa antes dos dois revelarem', () => {
    const m = novaPartida()
    expect(m.phase).toBe('revealing')

    expect(m.reveal(ALICE, nonceA, T0)).toBe(false)
    expect(m.phase).toBe('revealing')
    expect(m.table).toBeNull()

    expect(m.reveal(BOB, nonceB, T0)).toBe(true)
    expect(m.phase).toBe('playing')
    expect(m.table).not.toBeNull()
  })

  test('nonce que não bate com o compromisso é recusado', () => {
    const m = novaPartida()
    const outro = Uint8Array.from({ length: 32 }, () => 7)

    // Sem esta checagem, o segundo a revelar escolheria o nonce depois de ver
    // o do adversário e controlaria a quebra sozinho.
    expect(() => m.reveal(ALICE, outro, T0)).toThrow(MatchRuleError)
    expect(m.phase).toBe('revealing')
  })

  test('ninguém revela duas vezes', () => {
    const m = novaPartida()
    m.reveal(ALICE, nonceA, T0)
    expect(() => m.reveal(ALICE, nonceA, T0)).toThrow(/já revelou/)
  })

  test('a ordem da concatenação importa e é fixa', () => {
    expect([...seedFromNonces(nonceA, nonceB)]).not.toEqual([...seedFromNonces(nonceB, nonceA)])
  })

  test('quem não revela a tempo anula a partida, sem vencedor', () => {
    const m = novaPartida()
    m.reveal(ALICE, nonceA, T0)

    const r = m.tick(T0 + REVEAL_TIMEOUT_MS)
    expect(r.changed).toBe(true)
    expect(m.phase).toBe('finished')

    // Sem vencedor: a partida não chegou a existir. O escrow volta pelos dois
    // pelo caminho de cancelamento on-chain.
    expect(m.result()?.winner).toBeNull()
    expect(m.result()?.reason).toBe('tempo')
  })
})

describe('vez e validação da tacada', () => {
  test('quem não é da vez não taca', () => {
    const m = partidaIniciada()
    const foraDaVez = m.players[m.turn === 0 ? 1 : 0].address

    expect(() => m.shoot(foraDaVez, tacada(180, 0.8), T0)).toThrow(/Não é a sua vez/)
  })

  test('carteira de fora é recusada', () => {
    const m = partidaIniciada()
    expect(() => m.shoot('Carol333', tacada(180, 0.8), T0)).toThrow(/não está nesta partida/)
  })

  test('recusa tacada fora das faixas do formato', () => {
    const m = partidaIniciada()
    const quem = enderecoDaVez(m)

    // O cliente é hostil por definição: qualquer coisa que chegue pela rede
    // pode ter sido escrita à mão.
    const invalidas = [
      { angle: 70_000, power: 100, spinX: 0, spinY: 0 },
      { angle: -1, power: 100, spinX: 0, spinY: 0 },
      { angle: 100, power: 900, spinX: 0, spinY: 0 },
      { angle: 100, power: 100, spinX: 200, spinY: 0 },
      { angle: 100, power: 100, spinX: 0, spinY: -200 },
      { angle: 1.5, power: 100, spinX: 0, spinY: 0 },
    ]

    for (const t of invalidas) {
      expect(() => m.shoot(quem, t, T0)).toThrow(MatchRuleError)
    }
    // Nenhuma delas entrou no replay.
    expect(m.recorder!.shotCount).toBe(0)
  })

  test('tacada válida avança a partida e entra no replay', () => {
    const m = partidaIniciada()
    const r = m.shoot(enderecoDaVez(m), tacada(180, 0.9), T0)

    expect(m.recorder!.shotCount).toBe(1)
    expect(r.stateHash).toHaveLength(8)
    expect(r.by).toBe(0)
  })

  test('não se taca durante uma decisão pendente', () => {
    const m = partidaIniciada()
    // Força uma pendência sintética para exercitar a guarda de fase.
    m.phase = 'deciding'
    expect(() => m.shoot(ALICE, tacada(0, 0.5), T0)).toThrow(/não está esperando uma tacada/)
  })
})

describe('prazo de tacada', () => {
  test('não dispara antes da hora', () => {
    const m = partidaIniciada()
    expect(m.tick(T0 + SHOT_CLOCK_MS - 1).changed).toBe(false)
  })

  test('estourar o prazo é falta, não passe de vez inventado', () => {
    const m = partidaIniciada()
    const antes = m.turn

    const r = m.tick(T0 + SHOT_CLOCK_MS)
    expect(r.timedOut).toBe(antes!)

    // A falta é registrada como tacada de força zero, então o replay a
    // reproduz sem nenhum caso especial.
    expect(m.recorder!.shotCount).toBe(1)
    expect(m.recorder!.build().shots[0]).toEqual({ angle: 0, power: 0, spinX: 0, spinY: 0 })
  })

  test('o relógio reinicia a cada tacada', () => {
    const m = partidaIniciada()
    m.shoot(enderecoDaVez(m), tacada(180, 0.9), T0 + 10_000)

    expect(m.deadline).toBe(T0 + 10_000 + SHOT_CLOCK_MS)
  })

  test('faltas de tempo seguidas terminam em W.O.', () => {
    const m = partidaIniciada()
    let agora = T0

    // A falta por tempo passa a vez, então dois jogadores parados alternam:
    // cada um só acumula falta no próprio turno. São 2× as rodadas.
    for (let i = 0; i < MAX_SHOT_CLOCK_FOULS * 2 && m.phase !== 'finished'; i++) {
      agora += SHOT_CLOCK_MS
      m.tick(agora)
    }

    expect(m.phase).toBe('finished')
    expect(m.result()?.reason).toBe('tempo')
    expect(m.result()?.winner).not.toBeNull()
  })

  test('a falta por tempo passa a vez', () => {
    const m = partidaIniciada()
    const antes = m.turn

    m.tick(T0 + SHOT_CLOCK_MS)

    // Falta dá bola na mão ao adversário, então a vez vira. É por isso que um
    // jogador parado não acumula três faltas em três rodadas.
    expect(m.turn).not.toBe(antes)
  })

  test('tacar de verdade zera a contagem de faltas', () => {
    const m = partidaIniciada()
    let agora = T0

    // Duas faltas de tempo, uma abaixo do W.O.
    for (let i = 0; i < MAX_SHOT_CLOCK_FOULS - 1; i++) {
      agora += SHOT_CLOCK_MS
      m.tick(agora)
    }
    expect(m.phase).not.toBe('finished')

    // Cada jogador taca uma vez de verdade.
    for (let i = 0; i < 2; i++) {
      if (m.phase !== 'playing') break
      m.shoot(enderecoDaVez(m), tacada(200 + i * 30, 0.8), agora)
    }

    // E agora aguenta o mesmo tanto de faltas de novo, sem acabar.
    for (let i = 0; i < MAX_SHOT_CLOCK_FOULS - 1; i++) {
      agora += SHOT_CLOCK_MS
      m.tick(agora)
    }
    expect(m.phase).not.toBe('finished')
  })
})

describe('desistência e abandono', () => {
  test('quem desiste entrega a partida ao outro', () => {
    const m = partidaIniciada()
    m.forfeit(ALICE, T0)

    expect(m.phase).toBe('finished')
    expect(m.result()?.reason).toBe('desistência')
    expect(m.result()?.winner).toBe(1)
  })

  test('cair da conexão não perde na hora', () => {
    const m = partidaIniciada()
    m.markOffline(BOB, T0)

    m.tick(T0 + DISCONNECT_GRACE_MS - 1)

    // O relógio de tacada corre em paralelo e pode ter dado falta; o que não
    // pode é a partida ter acabado por abandono antes da tolerância.
    expect(m.result()?.reason).not.toBe('abandono')
  })

  test('voltar a tempo salva a partida do abandono', () => {
    const m = partidaIniciada()
    m.markOffline(BOB, T0)
    m.markOnline(BOB)

    m.tick(T0 + DISCONNECT_GRACE_MS * 10)
    expect(m.result()?.reason).not.toBe('abandono')
  })

  test('não voltar perde por abandono', () => {
    const m = partidaIniciada()
    m.markOffline(BOB, T0)

    m.tick(T0 + DISCONNECT_GRACE_MS)
    expect(m.result()?.reason).toBe('abandono')
    expect(m.result()?.winner).toBe(0)
  })

  test('abandono vence o prazo de tacada', () => {
    // Não faz sentido cobrar tacada de quem não está conectado: quem some
    // deve perder por abandono, que é o motivo verdadeiro.
    const m = partidaIniciada()
    const daVez = m.turn!
    m.markOffline(m.players[daVez].address, T0)

    m.tick(T0 + DISCONNECT_GRACE_MS)
    expect(m.result()?.reason).toBe('abandono')
  })
})

describe('o replay da partida em rede é verificável', () => {
  test('uma partida jogada pelo servidor reproduz o mesmo vencedor', () => {
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 40; i++) {
      if (m.phase !== 'playing') break
      agora += 1_000
      m.shoot(enderecoDaVez(m), tacada((i * 47) % 360, 0.5 + ((i * 7) % 40) / 100), agora)
    }

    const bytes = m.recorder!.toBytes()
    const conferido = verifyReplay(decodeReplay(bytes))

    // O verificador parte só dos bytes e chega ao mesmo lugar que o servidor.
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
    expect(conferido.winner).toBe(m.summary!.winner)
  })

  test('a falta por tempo também é reproduzível', () => {
    const m = partidaIniciada()
    let agora = T0

    m.shoot(enderecoDaVez(m), tacada(180, 0.9), agora)
    agora += SHOT_CLOCK_MS
    m.tick(agora)

    // A falta abre bola na mão; colocar a branca é obrigatório antes de jogar.
    if (m.ballInHand !== null) {
      m.place(m.players[m.summary!.turn].address, 0.5, 0.5, agora)
    }
    if (m.phase === 'playing' && m.ballInHand === null) {
      m.shoot(enderecoDaVez(m), tacada(90, 0.6), agora)
    }

    const conferido = verifyReplay(decodeReplay(m.recorder!.toBytes()))
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
  })

  test('o taco de cada jogador vai gravado', () => {
    const m = partidaIniciada()
    const r = m.recorder!.build()

    expect(r.cues[0]).toEqual(DEFAULT_CUE)
    expect(r.cues[1]).toEqual(CUE_ARCHETYPES.pesado)
  })
})

describe('bola na mão', () => {
  /** Leva a partida até uma falta, para abrir a bola na mão. */
  function comFalta(): { m: Match; agora: number } {
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 12 && m.ballInHand === null && m.phase === 'playing'; i++) {
      agora += 1_000
      m.shoot(enderecoDaVez(m), tacada((i * 61) % 360, 0.9), agora)
    }
    return { m, agora }
  }

  test('não se taca com a branca encaçapada', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    // A física recusaria de qualquer forma, mas com uma mensagem sobre estado
    // interno. Esta diz o que o jogador precisa fazer.
    expect(() => m.shoot(enderecoDaVez(m), tacada(0, 0.5), agora)).toThrow(/Coloque a branca/)
  })

  test('a posição é gravada no replay', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const antes = m.recorder!.placementCount
    m.place(m.players[m.summary!.turn].address, 1.2, 0.4, agora)

    expect(m.recorder!.placementCount).toBe(antes + 1)
    expect(m.ballInHand).toBeNull()
  })

  test('a bola na mão é de quem tem a vez', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const outro = m.players[m.summary!.turn === 0 ? 1 : 0].address
    expect(() => m.place(outro, 1, 0.5, agora)).toThrow(/não é sua/)
  })

  test('quem não coloca a tempo fica com o ponto de saque', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const antes = m.recorder!.placementCount
    m.tick(agora + SHOT_CLOCK_MS)

    // A posição neutra também vai gravada: o verificador precisa dela como
    // precisa de qualquer outra.
    expect(m.recorder!.placementCount).toBe(antes + 1)
  })

  test('a partida com bola na mão continua verificável', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    m.place(m.players[m.summary!.turn].address, 0.6, 0.7, agora)
    if (m.phase === 'playing' && m.ballInHand === null) {
      m.shoot(enderecoDaVez(m), tacada(10, 0.7), agora + 1000)
    }

    const conferido = verifyReplay(decodeReplay(m.recorder!.toBytes()))
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
    expect(conferido.stoppedBecause).toBeNull()
  })
})
