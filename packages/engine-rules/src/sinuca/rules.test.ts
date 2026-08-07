import { describe, expect, test } from 'bun:test'
import { applySinucaRuling, forfeitSinuca, judgeSinucaShot, playSinucaShot } from './rules'
import {
  BALL_NAMES,
  CUE_BALL,
  DEFAULT_SINUCA_RULES,
  ballOnTurn,
  createSinucaMatch,
  isDecided,
  pointsRemaining,
  valueOf,
  type SinucaOutcome,
  type SinucaState,
} from './types'

/**
 * Cada teste corresponde a uma regra da sinuca brasileira. As diferenças em
 * relação ao 8-Ball são o que mais importa aqui — são elas que um port
 * apressado do outro jogo erraria.
 */

function tacada(over: Partial<SinucaOutcome> = {}): SinucaOutcome {
  return {
    firstContact: 1,
    pocketed: [],
    offTable: [],
    railAfterContact: true,
    nominated: null,
    ...over,
  }
}

const mesa = (over: Partial<SinucaState> = {}): SinucaState => ({
  ...createSinucaMatch(),
  broken: true,
  ...over,
})

describe('valores e bola da vez', () => {
  test('o número da bola é o valor dela', () => {
    for (let i = 1; i <= 7; i++) expect(valueOf(i)).toBe(i)
    expect(valueOf(CUE_BALL)).toBe(0)
  })

  test('toda bola tem nome para a interface', () => {
    for (let i = 1; i <= 7; i++) expect(BALL_NAMES[i]).toBeTruthy()
  })

  test('a bola da vez é sempre a MENOR na mesa', () => {
    // Diferença central em relação ao 8-Ball: não há grupo por jogador.
    expect(ballOnTurn(mesa())).toBe(1)
    expect(ballOnTurn(mesa({ onTable: [3, 5, 7] }))).toBe(3)
    expect(ballOnTurn(mesa({ onTable: [7] }))).toBe(7)
    expect(ballOnTurn(mesa({ onTable: [] }))).toBeNull()
  })

  test('pontos restantes somam as bolas na mesa', () => {
    expect(pointsRemaining(mesa())).toBe(28) // 1+2+…+7
    expect(pointsRemaining(mesa({ onTable: [6, 7] }))).toBe(13)
  })
})

describe('pontuação', () => {
  test('encaçapar a bola da vez marca o valor dela', () => {
    const { state, ruling } = playSinucaShot(mesa(), tacada({ firstContact: 1, pocketed: [1] }))

    expect(ruling.scored).toBe(1)
    expect(state.score).toEqual([1, 0])
    expect(state.onTable).not.toContain(1)
  })

  test('encaçapar a bola da vez mantém a vez', () => {
    const { state } = playSinucaShot(mesa(), tacada({ firstContact: 1, pocketed: [1] }))
    expect(state.turn).toBe(0)
  })

  test('acertar sem encaçapar passa a vez, sem punição', () => {
    const { state, ruling } = playSinucaShot(mesa(), tacada({ firstContact: 1 }))

    expect(ruling.foul).toBeNull()
    expect(ruling.scored).toBe(0)
    expect(state.turn).toBe(1)
    expect(state.score).toEqual([0, 0])
  })

  test('bolas maiores valem mais', () => {
    const { state } = playSinucaShot(
      mesa({ onTable: [7] }),
      tacada({ firstContact: 7, pocketed: [7] }),
    )
    expect(state.score).toEqual([7, 0])
  })

  test('os pontos se acumulam ao longo da partida', () => {
    let estado = mesa()
    estado = playSinucaShot(estado, tacada({ firstContact: 1, pocketed: [1] })).state
    estado = playSinucaShot(estado, tacada({ firstContact: 2, pocketed: [2] })).state
    estado = playSinucaShot(estado, tacada({ firstContact: 3, pocketed: [3] })).state

    expect(estado.score).toEqual([6, 0])
  })
})

describe('bola encaçapada indevidamente volta para a mesa', () => {
  test('encaçapar bola que não é a da vez devolve ela', () => {
    // No 8-Ball só a 8 volta; aqui qualquer uma volta.
    const { state, ruling } = playSinucaShot(
      mesa(),
      tacada({ firstContact: 1, pocketed: [5] }),
    )

    expect(ruling.respot).toEqual([5])
    expect(state.onTable).toContain(5)
    expect(state.score).toEqual([0, 0])
  })

  test('encaçapar a da vez junto com outra: só a da vez sai', () => {
    const { state, ruling } = playSinucaShot(
      mesa(),
      tacada({ firstContact: 1, pocketed: [1, 6] }),
    )

    expect(ruling.scored).toBe(1)
    expect(ruling.respot).toEqual([6])
    expect(state.onTable).not.toContain(1)
    expect(state.onTable).toContain(6)
  })

  test('falta devolve tudo que caiu', () => {
    const { state } = playSinucaShot(
      mesa(),
      tacada({ firstContact: 1, pocketed: [1, 2, CUE_BALL] }),
    )

    expect(state.onTable).toContain(1)
    expect(state.onTable).toContain(2)
  })
})

describe('faltas', () => {
  test('branca na caçapa dá 7 ao adversário', () => {
    const { state, ruling } = playSinucaShot(mesa(), tacada({ pocketed: [CUE_BALL] }))

    expect(ruling.foul).toBe('cue-ball-pocketed')
    expect(ruling.penalty).toBe(7)
    expect(state.score).toEqual([0, 7])
  })

  test('branca fora da mesa', () => {
    expect(judgeSinucaShot(mesa(), tacada({ offTable: [CUE_BALL] })).foul).toBe(
      'cue-ball-off-table',
    )
  })

  test('bola colorida fora da mesa', () => {
    expect(judgeSinucaShot(mesa(), tacada({ firstContact: 1, offTable: [3] })).foul).toBe(
      'ball-off-table',
    )
  })

  test('não tocar em nada', () => {
    expect(judgeSinucaShot(mesa(), tacada({ firstContact: null })).foul).toBe('no-contact')
  })

  test('bater primeiro em bola que não é a da vez', () => {
    expect(judgeSinucaShot(mesa(), tacada({ firstContact: 4 })).foul).toBe('wrong-ball-first')
  })

  test('nenhuma bola na tabela e nada encaçapado', () => {
    expect(
      judgeSinucaShot(mesa(), tacada({ firstContact: 1, railAfterContact: false })).foul,
    ).toBe('no-rail-after-contact')
  })

  test('falta passa a vez e dá bola na mão', () => {
    const { state } = playSinucaShot(mesa(), tacada({ firstContact: null }))

    expect(state.turn).toBe(1)
    expect(state.ballInHand).toBe(true)
  })

  test('falta não pontua para quem cometeu', () => {
    const { state } = playSinucaShot(
      mesa(),
      tacada({ firstContact: 1, pocketed: [1, CUE_BALL] }),
    )
    expect(state.score[0]).toBe(0)
  })

  test('o valor da falta é configurável', () => {
    const { state } = playSinucaShot(mesa(), tacada({ firstContact: null }), {
      ...DEFAULT_SINUCA_RULES,
      foulPoints: 4,
    })
    expect(state.score).toEqual([0, 4])
  })
})

describe('bola livre', () => {
  test('encaçapar a da vez dá direito a declarar bola livre', () => {
    const { state } = playSinucaShot(
      mesa(),
      tacada({ firstContact: 1, pocketed: [1], nominated: 6 }),
    )
    expect(state.nominated).toBe(6)
  })

  test('a bola livre vira o alvo da próxima tacada', () => {
    const comLivre = mesa({ onTable: [2, 3, 6], nominated: 6 })
    // Bater na 2 (que seria a da vez) agora é falta.
    expect(judgeSinucaShot(comLivre, tacada({ firstContact: 2 })).foul).toBe('free-ball-missed')
    expect(judgeSinucaShot(comLivre, tacada({ firstContact: 6 })).foul).toBeNull()
  })

  test('acertar e encaçapar a livre pontua o valor dela', () => {
    const comLivre = mesa({ onTable: [2, 3, 6], nominated: 6 })
    const { ruling } = playSinucaShot(comLivre, tacada({ firstContact: 6, pocketed: [6] }))

    expect(ruling.scored).toBe(6)
  })

  test('errar a livre é falta com nome próprio', () => {
    // O jogador escolheu o risco; a mensagem precisa dizer isso.
    const comLivre = mesa({ nominated: 7 })
    expect(judgeSinucaShot(comLivre, tacada({ firstContact: 1 })).foul).toBe('free-ball-missed')
  })

  test('o direito à livre vale só a próxima tacada', () => {
    const comLivre = mesa({ onTable: [2, 6], nominated: 6 })
    const { state } = playSinucaShot(
      comLivre,
      tacada({ firstContact: 6, pocketed: [6], nominated: null }),
    )
    expect(state.nominated).toBeNull()
  })

  test('desligando a regra, o alvo é sempre a menor bola', () => {
    const semLivre = { ...DEFAULT_SINUCA_RULES, freeBallAfterPot: false }
    const comLivre = mesa({ onTable: [2, 6], nominated: 6 })

    expect(judgeSinucaShot(comLivre, tacada({ firstContact: 2 }), semLivre).foul).toBeNull()
  })
})

describe('fim de partida', () => {
  test('acabaram as bolas: vence quem tem mais pontos', () => {
    const ultima = mesa({ onTable: [7], score: [10, 4] })
    const { state, ruling } = playSinucaShot(ultima, tacada({ firstContact: 7, pocketed: [7] }))

    expect(ruling.winner).toBe(0)
    expect(state.ending).toEqual({ kind: 'all-balls-potted' })
    expect(state.score).toEqual([17, 4])
  })

  test('a última bola pode virar a partida', () => {
    const ultima = mesa({ onTable: [7], score: [4, 8] })
    const { ruling } = playSinucaShot(ultima, tacada({ firstContact: 7, pocketed: [7] }))

    expect(ruling.winner).toBe(0) // 11 a 8
  })

  test('partida decidida encerra antes de acabarem as bolas', () => {
    // Sobram 1+2 = 3 pontos e a diferença é 10: não há virada possível.
    const decidida = mesa({ onTable: [1, 2], score: [15, 5] })
    const { ruling } = playSinucaShot(decidida, tacada({ firstContact: 1 }))

    expect(ruling.winner).toBe(0)
    expect(ruling.ending).toEqual({ kind: 'score-unreachable' })
  })

  test('não encerra enquanto a virada for possível', () => {
    // Sobram 6+7 = 13 e a diferença é 10.
    const aberta = mesa({ onTable: [6, 7], score: [15, 5] })
    expect(judgeSinucaShot(aberta, tacada({ firstContact: 6 })).winner).toBeNull()
  })

  test('isDecided reconhece a partida decidida', () => {
    expect(isDecided(mesa({ onTable: [1], score: [10, 0] }))).toBe(true)
    expect(isDecided(mesa({ onTable: [7], score: [10, 5] }))).toBe(false)
  })

  test('a falta pode decidir a partida', () => {
    const apertada = mesa({ onTable: [1], score: [0, 5] })
    const { ruling } = playSinucaShot(apertada, tacada({ firstContact: null }))

    // 5 + 7 = 12 contra 0, e só resta 1 ponto na mesa.
    expect(ruling.winner).toBe(1)
  })

  test('desligando o encerramento antecipado, a partida vai até o fim', () => {
    const decidida = mesa({ onTable: [1, 2], score: [15, 5] })
    const semAntecipar = { ...DEFAULT_SINUCA_RULES, endOnUnreachableScore: false }

    expect(judgeSinucaShot(decidida, tacada({ firstContact: 1 }), semAntecipar).winner).toBeNull()
  })

  test('desistência entrega a partida', () => {
    const estado = forfeitSinuca(mesa(), 0)
    expect(estado.winner).toBe(1)
    expect(estado.ending).toEqual({ kind: 'forfeit' })
  })

  test('jogar depois do fim é erro', () => {
    expect(() => judgeSinucaShot(mesa({ winner: 0 }), tacada())).toThrow()
  })
})

describe('pureza e determinismo', () => {
  test('judgeSinucaShot não altera o estado recebido', () => {
    const estado = mesa()
    const antes = JSON.stringify(estado)
    judgeSinucaShot(estado, tacada({ firstContact: 1, pocketed: [1] }))

    expect(JSON.stringify(estado)).toBe(antes)
  })

  test('applySinucaRuling não altera o estado recebido', () => {
    const estado = mesa()
    const antes = JSON.stringify(estado)
    const saida = tacada({ firstContact: 1, pocketed: [1] })
    applySinucaRuling(estado, saida, judgeSinucaShot(estado, saida))

    expect(JSON.stringify(estado)).toBe(antes)
  })

  test('uma partida inteira é reproduzível', () => {
    const jogar = () => {
      let estado = createSinucaMatch()
      const tacadas = [
        tacada({ firstContact: 1, pocketed: [1] }),
        tacada({ firstContact: 2, pocketed: [2, 5] }),
        tacada({ firstContact: 3 }),
        tacada({ firstContact: 3, pocketed: [CUE_BALL] }),
        tacada({ firstContact: 3, pocketed: [3] }),
      ]
      for (const t of tacadas) {
        if (estado.winner !== null) break
        estado = playSinucaShot(estado, t).state
      }
      return JSON.stringify(estado)
    }
    expect(jogar()).toBe(jogar())
  })
})
