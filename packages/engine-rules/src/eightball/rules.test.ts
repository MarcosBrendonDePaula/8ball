import { describe, expect, test } from 'bun:test'
import { applyRuling, forfeit, judgeShot, playShot, resolveChoice, stalemate } from './rules'
import {
  BAR_RULES,
  CUE_BALL,
  DEFAULT_RULES,
  EIGHT_BALL,
  WPA_RULES,
  canShootEight,
  createMatch,
  groupFor,
  remainingFor,
  type MatchState,
  type Pocket,
  type ShotOutcome,
} from './types'

/**
 * Cada teste corresponde a uma regra das World Standardized Rules da WPA. Se
 * um falhar, é uma regra que o jogo aplica errado — e numa mesa com aposta,
 * regra errada é dinheiro indo para a pessoa errada.
 */

function tacada(over: Partial<ShotOutcome> = {}): ShotOutcome {
  return {
    firstContact: 1,
    pocketed: [],
    offTable: [],
    ballsToRail: 4,
    railAfterContact: true,
    eightBallPocket: null,
    called: null,
    ...over,
  }
}

/** Mesa depois da quebra, com grupos definidos. */
function comGrupos(over: Partial<MatchState> = {}): MatchState {
  return {
    ...createMatch(),
    broken: true,
    groups: { open: false, first: 'solids', second: 'stripes' },
    ...over,
  }
}

const limpo = (over: Partial<MatchState> = {}): MatchState =>
  comGrupos({ pocketed: [1, 2, 3, 4, 5, 6, 7], ...over })

describe('quebra — validade', () => {
  test('quebra que encaçapa é válida', () => {
    const { ruling } = playShot(createMatch(), tacada({ pocketed: [3], ballsToRail: 0 }))
    expect(ruling.pending).toBeNull()
    expect(ruling.foul).toBeNull()
  })

  test('quebra com 4 bolas na tabela é válida mesmo sem encaçapar', () => {
    const { ruling } = playShot(createMatch(), tacada({ pocketed: [], ballsToRail: 4 }))
    expect(ruling.pending).toBeNull()
  })

  test('quebra fraca é inválida e o adversário escolhe', () => {
    // Regra que muita implementação ignora: não é falta, é escolha.
    const { ruling } = playShot(createMatch(), tacada({ pocketed: [], ballsToRail: 2 }))

    expect(ruling.pending).toEqual({ kind: 'illegal-break', chooser: 1 })
    expect(ruling.foul).toBeNull()
  })

  test('o adversário pode aceitar a mesa como está', () => {
    const { state } = playShot(createMatch(), tacada({ ballsToRail: 1 }))
    const depois = resolveChoice(state, 'accept')

    expect(depois.pending).toBeNull()
    expect(depois.broken).toBe(true)
    expect(depois.turn).toBe(1)
  })

  test('o adversário pode mandar quebrar de novo', () => {
    const { state } = playShot(createMatch(), tacada({ ballsToRail: 1 }))
    const depois = resolveChoice(state, 'rerack-opponent')

    expect(depois.broken).toBe(false)
    expect(depois.breaker).toBe(0)
    expect(depois.pocketed).toEqual([])
  })

  test('o adversário pode quebrar ele mesmo', () => {
    const { state } = playShot(createMatch(), tacada({ ballsToRail: 1 }))
    const depois = resolveChoice(state, 'rerack-self')

    expect(depois.breaker).toBe(1)
    expect(depois.turn).toBe(1)
  })

  test('nas regras de bar, quebra fraca vale', () => {
    const { ruling } = playShot(createMatch(), tacada({ ballsToRail: 0 }), BAR_RULES)
    expect(ruling.pending).toBeNull()
  })
})

describe('quebra — a bola 8', () => {
  test('encaçapar a 8 na quebra NÃO perde, pela WPA', () => {
    // O erro mais comum ao implementar 8-Ball.
    const { ruling } = playShot(
      createMatch(),
      tacada({ pocketed: [EIGHT_BALL], eightBallPocket: 0 as Pocket }),
    )

    expect(ruling.winner).toBeNull()
    expect(ruling.pending).toEqual({ kind: 'eight-on-break', chooser: 0 })
  })

  test('o quebrador pode recolocar a 8 e seguir', () => {
    const { state } = playShot(createMatch(), tacada({ pocketed: [EIGHT_BALL, 2] }))
    const depois = resolveChoice(state, 'respot-eight')

    expect(depois.pocketed).not.toContain(EIGHT_BALL)
    expect(depois.pocketed).toContain(2)
    expect(depois.winner).toBeNull()
  })

  test('o quebrador pode quebrar de novo', () => {
    const { state } = playShot(createMatch(), tacada({ pocketed: [EIGHT_BALL] }))
    const depois = resolveChoice(state, 'rerack-self')

    expect(depois.broken).toBe(false)
    expect(depois.pocketed).toEqual([])
  })

  test('nas regras de bar, a 8 na quebra perde', () => {
    const { ruling } = playShot(
      createMatch(),
      tacada({ pocketed: [EIGHT_BALL] }),
      BAR_RULES,
    )
    expect(ruling.winner).toBe(1)
  })
})

describe('quebra — falta', () => {
  test('branca na caçapa é falta e restringe à cozinha', () => {
    const { ruling, state } = playShot(createMatch(), tacada({ pocketed: [CUE_BALL, 3] }))

    expect(ruling.foul).toBe('cue-ball-pocketed')
    expect(state.ballInHand).toEqual({ active: true, region: 'kitchen' })
  })

  test('nas regras de bar, falta na quebra dá a mesa inteira', () => {
    const { state } = playShot(
      createMatch(),
      tacada({ pocketed: [CUE_BALL, 3] }),
      BAR_RULES,
    )
    expect(state.ballInHand).toEqual({ active: true, region: 'anywhere' })
  })

  test('a quebra não define grupos, nem encaçapando', () => {
    const { state } = playShot(createMatch(), tacada({ pocketed: [1, 3] }))
    expect(state.groups.open).toBe(true)
  })

  test('bater em qualquer bola na quebra é legal', () => {
    for (const primeira of [1, 8, 15]) {
      expect(playShot(createMatch(), tacada({ firstContact: primeira })).ruling.foul).toBeNull()
    }
  })
})

describe('mesa aberta', () => {
  const aberta = (): MatchState => ({ ...createMatch(), broken: true })

  test('bater primeiro na 8 com a mesa aberta é FALTA', () => {
    // "Aberta" não quer dizer que tudo vale.
    const { ruling } = playShot(aberta(), tacada({ firstContact: EIGHT_BALL }))
    expect(ruling.foul).toBe('eight-ball-first-illegal')
  })

  test('bater em qualquer numerada é legal', () => {
    for (const primeira of [1, 7, 9, 15]) {
      expect(judgeShot(aberta(), tacada({ firstContact: primeira })).foul).toBeNull()
    }
  })

  test('a primeira encaçapada legal define os grupos', () => {
    const { state } = playShot(aberta(), tacada({ firstContact: 2, pocketed: [2] }))
    expect(state.groups).toEqual({ open: false, first: 'solids', second: 'stripes' })
  })

  test('encaçapar listrada dá as listradas', () => {
    const { state } = playShot(aberta(), tacada({ firstContact: 10, pocketed: [10] }))
    expect(groupFor(state.groups, 0)).toBe('stripes')
    expect(groupFor(state.groups, 1)).toBe('solids')
  })

  test('o jogador 1 recebe o lado certo', () => {
    const vezDoUm: MatchState = { ...aberta(), turn: 1 }
    const { state } = playShot(vezDoUm, tacada({ firstContact: 3, pocketed: [3] }))

    expect(groupFor(state.groups, 1)).toBe('solids')
    expect(groupFor(state.groups, 0)).toBe('stripes')
  })

  test('com declaração obrigatória, é a bola DECLARADA que define o grupo', () => {
    // Encaçapar de raspão não escolhe lado por você.
    const { state } = playShot(
      aberta(),
      tacada({
        firstContact: 2,
        pocketed: [11, 2],
        called: { ball: 2, pocket: 1 as Pocket },
      }),
      WPA_RULES,
    )
    expect(groupFor(state.groups, 0)).toBe('solids')
  })

  test('sem encaçapar, os grupos continuam abertos', () => {
    const { state } = playShot(aberta(), tacada({ firstContact: 5 }))
    expect(state.groups.open).toBe(true)
  })
})

describe('faltas', () => {
  test('branca na caçapa', () => {
    expect(judgeShot(comGrupos(), tacada({ pocketed: [CUE_BALL] })).foul).toBe(
      'cue-ball-pocketed',
    )
  })

  test('branca fora da mesa', () => {
    expect(judgeShot(comGrupos(), tacada({ offTable: [CUE_BALL] })).foul).toBe(
      'cue-ball-off-table',
    )
  })

  test('bola numerada fora da mesa', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: 3, offTable: [5] })).foul).toBe(
      'ball-off-table',
    )
  })

  test('bola que saiu da mesa NÃO volta — só a 8 é recolocada', () => {
    const { state } = playShot(comGrupos(), tacada({ firstContact: 3, offTable: [5] }))
    expect(state.pocketed).toContain(5)
  })

  test('não tocar em nenhuma bola', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: null })).foul).toBe('no-contact')
  })

  test('bater primeiro na bola do adversário', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: 12 })).foul).toBe('wrong-ball-first')
  })

  test('bater na própria bola é legal', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: 5 })).foul).toBeNull()
  })

  test('nenhuma bola na tabela e nada encaçapado', () => {
    expect(
      judgeShot(comGrupos(), tacada({ firstContact: 3, railAfterContact: false })).foul,
    ).toBe('no-rail-after-contact')
  })

  test('encaçapar dispensa a exigência de tabela', () => {
    expect(
      judgeShot(
        comGrupos(),
        tacada({ firstContact: 3, pocketed: [3], railAfterContact: false }),
      ).foul,
    ).toBeNull()
  })

  test('mirar na 8 antes de limpar o grupo', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: EIGHT_BALL })).foul).toBe(
      'eight-ball-first-illegal',
    )
  })

  test('falta passa a vez e dá bola na mão na mesa inteira', () => {
    const { state } = playShot(comGrupos(), tacada({ firstContact: null }))

    expect(state.turn).toBe(1)
    expect(state.ballInHand).toEqual({ active: true, region: 'anywhere' })
  })

  test('tacada legal não dá bola na mão', () => {
    const { state } = playShot(comGrupos(), tacada({ firstContact: 4, pocketed: [4] }))
    expect(state.ballInHand).toEqual({ active: false })
  })
})

describe('declaração de tacada', () => {
  test('WPA exige declarar em toda tacada', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: 3 }), WPA_RULES).foul).toBe('no-call')
  })

  test('declarar e encaçapar a declarada é legal', () => {
    expect(
      judgeShot(
        comGrupos(),
        tacada({ firstContact: 3, pocketed: [3], called: { ball: 3, pocket: 2 as Pocket } }),
        WPA_RULES,
      ).foul,
    ).toBeNull()
  })

  test('encaçapar outra bola que não a declarada é falta', () => {
    expect(
      judgeShot(
        comGrupos(),
        tacada({ firstContact: 3, pocketed: [4], called: { ball: 3, pocket: 2 as Pocket } }),
        WPA_RULES,
      ).foul,
    ).toBe('wrong-ball-called')
  })

  test('encaçapar a declarada junto com extras é legal', () => {
    expect(
      judgeShot(
        comGrupos(),
        tacada({ firstContact: 3, pocketed: [3, 5], called: { ball: 3, pocket: 2 as Pocket } }),
        WPA_RULES,
      ).foul,
    ).toBeNull()
  })

  test('o padrão do projeto só exige declaração na 8', () => {
    expect(judgeShot(comGrupos(), tacada({ firstContact: 3 }), DEFAULT_RULES).foul).toBeNull()
    expect(judgeShot(limpo(), tacada({ firstContact: EIGHT_BALL }), DEFAULT_RULES).foul).toBe(
      'no-call',
    )
  })

  test('regras de bar nunca exigem declaração', () => {
    expect(judgeShot(limpo(), tacada({ firstContact: EIGHT_BALL }), BAR_RULES).foul).toBeNull()
  })
})

describe('continuidade da vez', () => {
  test('encaçapar bola do próprio grupo mantém a vez', () => {
    expect(playShot(comGrupos(), tacada({ firstContact: 3, pocketed: [3] })).state.turn).toBe(0)
  })

  test('não encaçapar passa a vez', () => {
    expect(playShot(comGrupos(), tacada({ firstContact: 3 })).state.turn).toBe(1)
  })

  test('encaçapar só bola do adversário passa a vez, sem ser falta', () => {
    const { ruling, state } = playShot(comGrupos(), tacada({ firstContact: 2, pocketed: [11] }))

    expect(ruling.foul).toBeNull()
    expect(state.turn).toBe(1)
  })

  test('encaçapar a sua e a do adversário mantém a vez', () => {
    expect(
      playShot(comGrupos(), tacada({ firstContact: 2, pocketed: [2, 11] })).state.turn,
    ).toBe(0)
  })
})

describe('a bola 8', () => {
  const naCacapa = (pocket: number, called: number | null = pocket) =>
    tacada({
      firstContact: EIGHT_BALL,
      pocketed: [EIGHT_BALL],
      eightBallPocket: pocket as Pocket,
      called: called === null ? null : { ball: EIGHT_BALL, pocket: called as Pocket },
    })

  test('só pode mirar na 8 depois de limpar o grupo', () => {
    expect(canShootEight(comGrupos(), 0)).toBe(false)
    expect(canShootEight(limpo(), 0)).toBe(true)
  })

  test('na caçapa declarada, vence', () => {
    const { ruling, state } = playShot(limpo(), naCacapa(2))

    expect(ruling.winner).toBe(0)
    expect(state.ending).toEqual({ kind: 'eight-ball-potted' })
  })

  test('na caçapa errada, perde', () => {
    const { ruling, state } = playShot(limpo(), naCacapa(5, 1))

    expect(ruling.winner).toBe(1)
    expect(state.ending).toEqual({ kind: 'eight-ball-wrong-pocket' })
  })

  test('antes de limpar o grupo, perde', () => {
    const { ruling, state } = playShot(
      comGrupos(),
      tacada({ firstContact: 2, pocketed: [EIGHT_BALL], eightBallPocket: 0 as Pocket }),
    )

    expect(ruling.winner).toBe(1)
    expect(state.ending?.kind).toBe('eight-ball-early')
  })

  test('junto com a branca, perde mesmo na caçapa certa', () => {
    const { ruling, state } = playShot(
      limpo(),
      tacada({
        firstContact: EIGHT_BALL,
        pocketed: [EIGHT_BALL, CUE_BALL],
        eightBallPocket: 3 as Pocket,
        called: { ball: EIGHT_BALL, pocket: 3 as Pocket },
      }),
    )

    expect(ruling.winner).toBe(1)
    expect(state.ending).toEqual({ kind: 'eight-ball-with-foul', foul: 'cue-ball-pocketed' })
  })

  test('a 8 fora da mesa perde', () => {
    const { ruling, state } = playShot(
      limpo(),
      tacada({ firstContact: EIGHT_BALL, offTable: [EIGHT_BALL] }),
    )

    expect(ruling.winner).toBe(1)
    expect(state.ending).toEqual({ kind: 'eight-ball-off-table' })
  })

  test('quem limpou o grupo não pode bater em bola do adversário', () => {
    // Declara a 8 para isolar a regra: sem isso, a falta reportada seria a de
    // declaração, que é cronologicamente anterior.
    const saida = tacada({
      firstContact: 12,
      called: { ball: EIGHT_BALL, pocket: 0 as Pocket },
    })
    expect(judgeShot(limpo(), saida).foul).toBe('wrong-ball-first')
  })
})

describe('três faltas seguidas', () => {
  const comTresFaltas = { ...WPA_RULES, callShot: 'never' as const }

  test('a terceira falta seguida entrega a partida', () => {
    let estado = comGrupos({ consecutiveFouls: [2, 0] })
    const { ruling } = playShot(estado, tacada({ firstContact: null }), comTresFaltas)

    expect(ruling.winner).toBe(1)
    expect(ruling.ending).toEqual({ kind: 'three-fouls' })
  })

  test('tacada legal zera o contador', () => {
    const estado = comGrupos({ consecutiveFouls: [2, 0] })
    const { state } = playShot(estado, tacada({ firstContact: 3, pocketed: [3] }), comTresFaltas)

    expect(state.consecutiveFouls[0]).toBe(0)
  })

  test('desligada por padrão', () => {
    const estado = comGrupos({ consecutiveFouls: [2, 0] })
    expect(playShot(estado, tacada({ firstContact: null })).ruling.winner).toBeNull()
  })
})

describe('estado da partida', () => {
  test('bolas encaçapadas se acumulam', () => {
    let estado = comGrupos()
    estado = playShot(estado, tacada({ firstContact: 1, pocketed: [1] })).state
    estado = playShot(estado, tacada({ firstContact: 2, pocketed: [2, 3] })).state

    expect(estado.pocketed.sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  test('a branca não conta como encaçapada', () => {
    const { state } = playShot(comGrupos(), tacada({ pocketed: [CUE_BALL, 4] }))
    expect(state.pocketed).not.toContain(CUE_BALL)
    expect(state.pocketed).toContain(4)
  })

  test('remainingFor conta o que falta', () => {
    const estado = comGrupos({ pocketed: [1, 2, 3] })
    expect(remainingFor(estado, 0).sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
    expect(remainingFor(estado, 1)).toHaveLength(7)
  })

  test('mesa aberta: ninguém tem bolas restantes definidas', () => {
    expect(remainingFor(createMatch(), 0)).toEqual([])
  })

  test('judgeShot não altera o estado recebido', () => {
    const estado = comGrupos()
    const antes = JSON.stringify(estado)
    judgeShot(estado, tacada({ firstContact: 1, pocketed: [1] }))
    expect(JSON.stringify(estado)).toBe(antes)
  })

  test('applyRuling não altera o estado recebido', () => {
    const estado = comGrupos()
    const antes = JSON.stringify(estado)
    const saida = tacada({ firstContact: 1, pocketed: [1] })
    applyRuling(estado, saida, judgeShot(estado, saida))
    expect(JSON.stringify(estado)).toBe(antes)
  })

  test('jogar depois do fim é erro', () => {
    expect(() => judgeShot(comGrupos({ winner: 0 }), tacada())).toThrow()
  })

  test('jogar com decisão pendente é erro', () => {
    const pendente = comGrupos({ pending: { kind: 'illegal-break', chooser: 1 } })
    expect(() => judgeShot(pendente, tacada())).toThrow()
  })

  test('resolver sem decisão pendente é erro', () => {
    expect(() => resolveChoice(comGrupos(), 'accept')).toThrow()
  })
})

describe('fim de partida', () => {
  test('desistência entrega a partida', () => {
    const estado = forfeit(comGrupos(), 0)
    expect(estado.winner).toBe(1)
    expect(estado.ending).toEqual({ kind: 'forfeit' })
  })

  test('empate técnico: quem quebrou quebra de novo', () => {
    const estado = stalemate(comGrupos({ breaker: 1, pocketed: [1, 2] }))

    expect(estado.breaker).toBe(1)
    expect(estado.turn).toBe(1)
    expect(estado.pocketed).toEqual([])
    expect(estado.broken).toBe(false)
  })
})

describe('determinismo', () => {
  test('o mesmo par (estado, tacada) sempre dá o mesmo julgamento', () => {
    const estado = comGrupos({ pocketed: [1, 2] })
    const saida = tacada({ firstContact: 3, pocketed: [3, 11] })

    expect(JSON.stringify(judgeShot(estado, saida))).toBe(
      JSON.stringify(judgeShot(estado, saida)),
    )
  })

  test('uma partida inteira é reproduzível', () => {
    const jogar = () => {
      let estado = createMatch()
      const tacadas = [
        tacada({ firstContact: 1, pocketed: [1, 9] }),
        tacada({ firstContact: 2, pocketed: [2] }),
        tacada({ firstContact: 3 }),
        tacada({ firstContact: 10, pocketed: [10, 11] }),
        tacada({ firstContact: 12, pocketed: [CUE_BALL] }),
        tacada({ firstContact: 3, pocketed: [3, 4, 5] }),
      ]
      for (const t of tacadas) {
        if (estado.winner !== null || estado.pending !== null) break
        estado = playShot(estado, t).state
      }
      return JSON.stringify(estado)
    }
    expect(jogar()).toBe(jogar())
  })
})
