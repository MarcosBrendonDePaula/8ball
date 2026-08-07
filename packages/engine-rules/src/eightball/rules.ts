import {
  CUE_BALL,
  DEFAULT_RULES,
  EIGHT_BALL,
  canShootEight,
  groupFor,
  groupOf,
  otherPlayer,
  remainingFor,
  type BallInHand,
  type BreakChoice,
  type FoulReason,
  type Group,
  type GroupAssignment,
  type MatchState,
  type PlayerIndex,
  type RuleSet,
  type ShotOutcome,
  type ShotRuling,
} from './types'

/**
 * Regras do 8-Ball, conforme as World Standardized Rules da WPA.
 *
 * Funções PURAS: recebem estado e resultado da tacada, devolvem estado novo.
 * Sem mutação, relógio ou aleatório — o mesmo par (estado, tacada) sempre
 * produz o mesmo julgamento. É o que permite ao servidor julgar e ao cliente
 * prever sem os dois discordarem.
 *
 * Pontos da regra oficial que costumam ser implementados errado, e que aqui
 * estão explícitos:
 *
 *   - Encaçapar a 8 NA QUEBRA não é falta nem derrota. O quebrador escolhe
 *     entre recolocar a 8 e seguir, ou quebrar de novo.
 *   - Com a mesa aberta, bater primeiro na 8 é FALTA — "aberta" não significa
 *     que tudo vale.
 *   - Quebra inválida dá TRÊS opções ao adversário, não uma.
 *   - Falta na quebra restringe a bola na mão à cozinha; fora da quebra, não.
 *   - Só a 8 é recolocada. Nenhuma outra bola volta para a mesa.
 */

/** Julga a tacada. Não altera o estado recebido. */
export function judgeShot(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet = DEFAULT_RULES,
): ShotRuling {
  if (state.winner !== null) throw new Error('A partida já terminou.')
  if (state.pending !== null) throw new Error('Há uma decisão pendente antes da próxima tacada.')

  return state.broken
    ? judgeNormalShot(state, outcome, rules)
    : judgeBreakShot(state, outcome, rules)
}

// ------------------------------------------------------------------ quebra

/**
 * A quebra tem regras próprias.
 *
 * Não há bola alvo, não se declara nada, e encaçapar a 8 não decide a partida.
 */
function judgeBreakShot(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet,
): ShotRuling {
  const quebrador = state.turn
  const adversario = otherPlayer(quebrador)

  const semNada: Omit<ShotRuling, 'foul' | 'continues' | 'winner' | 'ending' | 'pending'> = {
    groups: state.groups,
    respotEight: false,
  }

  const oitoCaiu = outcome.pocketed.includes(EIGHT_BALL) || outcome.offTable.includes(EIGHT_BALL)
  const brancaCaiu =
    outcome.pocketed.includes(CUE_BALL) || outcome.offTable.includes(CUE_BALL)

  // Quebra inválida: nada encaçapado e poucas bolas na tabela.
  const encaçapouAlgo = outcome.pocketed.some((id) => id !== CUE_BALL)
  const quebraValida =
    encaçapouAlgo || outcome.ballsToRail >= rules.breakMinBallsToRail

  if (oitoCaiu) {
    if (rules.eightOnBreakLoses) {
      return {
        ...semNada,
        foul: null,
        continues: false,
        winner: adversario,
        ending: { kind: 'eight-ball-early' },
        pending: null,
      }
    }
    // WPA: o quebrador escolhe recolocar a 8 e seguir, ou quebrar de novo.
    return {
      ...semNada,
      foul: brancaCaiu ? 'cue-ball-pocketed' : null,
      continues: false,
      winner: null,
      ending: null,
      pending: { kind: 'eight-on-break', chooser: quebrador },
    }
  }

  if (!quebraValida) {
    return {
      ...semNada,
      foul: null,
      continues: false,
      winner: null,
      ending: null,
      pending: { kind: 'illegal-break', chooser: adversario },
    }
  }

  if (brancaCaiu) {
    return {
      ...semNada,
      foul: 'cue-ball-pocketed',
      continues: false,
      winner: null,
      ending: null,
      pending: null,
    }
  }

  // A quebra NÃO define grupos, mesmo encaçapando: é o que impede a sorte da
  // quebra de decidir quem fica com o lado melhor da mesa.
  return {
    ...semNada,
    foul: null,
    continues: encaçapouAlgo,
    winner: null,
    ending: null,
    pending: null,
  }
}

// ------------------------------------------------------------ tacada normal

function judgeNormalShot(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet,
): ShotRuling {
  const jogador = state.turn
  const adversario = otherPlayer(jogador)

  const falta = detectFoul(state, outcome, rules)
  const oitoCaiu = outcome.pocketed.includes(EIGHT_BALL)
  const oitoSaiu = outcome.offTable.includes(EIGHT_BALL)

  // A 8 fora da mesa perde, sempre.
  if (oitoSaiu) {
    return {
      foul: falta,
      continues: false,
      groups: state.groups,
      winner: adversario,
      ending: { kind: 'eight-ball-off-table' },
      pending: null,
      respotEight: false,
    }
  }

  if (oitoCaiu) return judgeEightBall(state, outcome, falta, jogador, adversario, rules)

  const grupos = assignGroups(state, outcome, rules)

  if (falta) {
    const seguidas = contarFaltas(state, jogador)
    if (rules.threeFoulRule && seguidas >= 3) {
      return {
        foul: falta,
        continues: false,
        groups: grupos,
        winner: adversario,
        ending: { kind: 'three-fouls' },
        pending: null,
        respotEight: false,
      }
    }
    return {
      foul: falta,
      continues: false,
      groups: grupos,
      winner: null,
      ending: null,
      pending: null,
      respotEight: false,
    }
  }

  // Continua na mesa se encaçapou bola SUA. Encaçapar a do adversário não é
  // falta, mas também não dá direito a outra tacada.
  const grupoDoJogador = groupFor(grupos, jogador)
  const encaçapouSua = outcome.pocketed.some((id) => {
    if (id === CUE_BALL || id === EIGHT_BALL) return false
    return grupoDoJogador === null || groupOf(id) === grupoDoJogador
  })

  return {
    foul: null,
    continues: encaçapouSua,
    groups: grupos,
    winner: null,
    ending: null,
    pending: null,
    respotEight: false,
  }
}

/**
 * Detecta falta.
 *
 * Ordem importa: a primeira encontrada é a reportada, e as mais graves vêm
 * antes para a mensagem ao jogador ser a mais informativa.
 */
function detectFoul(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet,
): FoulReason | null {
  if (outcome.pocketed.includes(CUE_BALL)) return 'cue-ball-pocketed'
  if (outcome.offTable.includes(CUE_BALL)) return 'cue-ball-off-table'

  // Bola numerada fora da mesa é falta — e ela NÃO volta (só a 8 é recolocada).
  if (outcome.offTable.some((id) => id !== CUE_BALL && id !== EIGHT_BALL)) {
    return 'ball-off-table'
  }

  const faltaDeclaração = checkCall(state, outcome, rules)
  if (faltaDeclaração) return faltaDeclaração

  if (outcome.firstContact === null) return 'no-contact'

  const alvoErrado = wrongFirstBall(state, outcome.firstContact)
  if (alvoErrado) return alvoErrado

  // Sem encaçapar, alguma bola precisa ter tocado a tabela. É a regra que
  // impede "estacionar" a branca sem tentar nada.
  if (outcome.pocketed.length === 0 && !outcome.railAfterContact) {
    return 'no-rail-after-contact'
  }

  return null
}

/**
 * Esta tacada exige declarar bola e caçapa?
 *
 * Exposto porque a interface precisa saber ANTES da tacada — é o que decide se
 * ela pede a caçapa ao jogador. O julgamento usa a mesma condição logo abaixo.
 */
export function callRequired(state: MatchState, rules: RuleSet = DEFAULT_RULES): boolean {
  return (
    rules.callShot === 'always' ||
    (rules.callShot === 'eight-only' && canShootEight(state, state.turn))
  )
}

/** A declaração exigida foi feita e cumprida? */
function checkCall(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet,
): FoulReason | null {
  if (!callRequired(state, rules)) return null
  if (!outcome.called) return 'no-call'

  // Declarou mas encaçapou outra coisa: a tacada não conta, mas só é FALTA se
  // a declarada não caiu. Encaçapar extras junto é permitido.
  const declaradaCaiu = outcome.pocketed.includes(outcome.called.ball)
  if (outcome.pocketed.length > 0 && !declaradaCaiu) return 'wrong-ball-called'

  return null
}

/** A primeira bola tocada era alvo válido? */
function wrongFirstBall(state: MatchState, firstContact: number): FoulReason | null {
  const jogador = state.turn

  if (firstContact === EIGHT_BALL) {
    // Com a mesa aberta, bater na 8 primeiro é falta. "Aberta" não quer dizer
    // que tudo vale — é o erro mais comum ao implementar 8-Ball.
    return canShootEight(state, jogador) ? null : 'eight-ball-first-illegal'
  }

  const grupo = groupFor(state.groups, jogador)
  if (grupo === null) return null // mesa aberta: qualquer numerada serve

  if (remainingFor(state, jogador).length === 0) return 'wrong-ball-first'

  return groupOf(firstContact) === grupo ? null : 'wrong-ball-first'
}

/**
 * Define os grupos na primeira encaçapada legal depois da quebra.
 *
 * Com declaração obrigatória, só a bola DECLARADA define o grupo — encaçapar
 * de raspão não escolhe lado por você.
 */
function assignGroups(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet,
): GroupAssignment {
  if (!state.groups.open) return state.groups

  const numeradas = outcome.pocketed.filter((id) => id !== CUE_BALL && id !== EIGHT_BALL)
  if (numeradas.length === 0) return state.groups

  const definidora =
    rules.callShot === 'never'
      ? numeradas[0]!
      : (outcome.called?.ball ?? numeradas[0]!)

  const grupo = groupOf(definidora)
  if (!grupo) return state.groups

  const outro: Group = grupo === 'solids' ? 'stripes' : 'solids'

  return state.turn === 0
    ? { open: false, first: grupo, second: outro }
    : { open: false, first: outro, second: grupo }
}

/** Encaçapar a 8 encerra a partida — para o bem ou para o mal. */
function judgeEightBall(
  state: MatchState,
  outcome: ShotOutcome,
  falta: FoulReason | null,
  jogador: PlayerIndex,
  adversario: PlayerIndex,
  rules: RuleSet,
): ShotRuling {
  const perde = (ending: ShotRuling['ending']): ShotRuling => ({
    foul: falta,
    continues: false,
    groups: state.groups,
    winner: adversario,
    ending,
    pending: null,
    respotEight: false,
  })

  if (!canShootEight(state, jogador)) return perde({ kind: 'eight-ball-early' })
  if (falta) return perde({ kind: 'eight-ball-with-foul', foul: falta })

  const precisaDeclarar = rules.callShot !== 'never'
  if (precisaDeclarar && outcome.called && outcome.eightBallPocket !== outcome.called.pocket) {
    return perde({ kind: 'eight-ball-wrong-pocket' })
  }

  return {
    foul: null,
    continues: false,
    groups: state.groups,
    winner: jogador,
    ending: { kind: 'eight-ball-potted' },
    pending: null,
    respotEight: false,
  }
}

const contarFaltas = (state: MatchState, jogador: PlayerIndex): number =>
  state.consecutiveFouls[jogador] + 1

// ------------------------------------------------------------- aplicação

/**
 * Aplica o julgamento e devolve o estado da próxima tacada.
 *
 * Separado de `judgeShot` porque a interface precisa MOSTRAR o julgamento
 * antes de avançar — "você cometeu falta" só faz sentido enquanto ainda é
 * visível de quem era a vez.
 */
export function applyRuling(
  state: MatchState,
  outcome: ShotOutcome,
  ruling: ShotRuling,
  rules: RuleSet = DEFAULT_RULES,
): MatchState {
  const pocketed = [...state.pocketed]
  for (const id of [...outcome.pocketed, ...outcome.offTable]) {
    // A branca volta para a mesa; a 8 recolocada também não conta como fora.
    if (id === CUE_BALL) continue
    if (id === EIGHT_BALL && ruling.respotEight) continue
    if (!pocketed.includes(id)) pocketed.push(id)
  }

  const jogador = state.turn
  const faltas: [number, number] = [...state.consecutiveFouls]
  faltas[jogador] = ruling.foul ? faltas[jogador] + 1 : 0

  return {
    turn: ruling.continues ? jogador : otherPlayer(jogador),
    groups: ruling.groups,
    pocketed,
    broken: true,
    breaker: state.breaker,
    ballInHand: ballInHandFor(state, ruling, rules),
    consecutiveFouls: faltas,
    pending: ruling.pending,
    winner: ruling.winner,
    ending: ruling.ending,
  }
}

/**
 * Onde o próximo jogador pode colocar a branca.
 *
 * Falta na QUEBRA restringe à cozinha; falta durante o jogo dá a mesa inteira.
 * Confundir os dois casos muda o equilíbrio da partida.
 */
function ballInHandFor(state: MatchState, ruling: ShotRuling, rules: RuleSet): BallInHand {
  if (!ruling.foul) return { active: false }

  const foiNaQuebra = !state.broken
  if (foiNaQuebra && rules.kitchenAfterBreakScratch) {
    return { active: true, region: 'kitchen' }
  }
  return { active: true, region: 'anywhere' }
}

/** Julga e aplica de uma vez. */
export function playShot(
  state: MatchState,
  outcome: ShotOutcome,
  rules: RuleSet = DEFAULT_RULES,
): { state: MatchState; ruling: ShotRuling } {
  const ruling = judgeShot(state, outcome, rules)
  return { state: applyRuling(state, outcome, ruling, rules), ruling }
}

// -------------------------------------------------------------- decisões

/**
 * Resolve a escolha pendente.
 *
 * As duas situações em que a WPA dá opção ao jogador. Resolver automaticamente
 * seria tirar dele um direito que a regra concede.
 */
export function resolveChoice(state: MatchState, choice: BreakChoice): MatchState {
  const pendente = state.pending
  if (!pendente) throw new Error('Não há decisão pendente.')

  const base: MatchState = { ...state, pending: null }

  if (pendente.kind === 'eight-on-break') {
    if (choice === 'respot-eight') {
      // Segue a partida com a 8 de volta na mesa.
      return {
        ...base,
        pocketed: base.pocketed.filter((id) => id !== EIGHT_BALL),
        turn: pendente.chooser,
      }
    }
    // Qualquer outra escolha: quebra de novo.
    return novoRack(state, pendente.chooser)
  }

  // Quebra inválida.
  switch (choice) {
    case 'accept':
      // Aceita a mesa como está e joga.
      return { ...base, broken: true, turn: pendente.chooser }
    case 'rerack-self':
      return novoRack(state, pendente.chooser)
    default:
      return novoRack(state, otherPlayer(pendente.chooser))
  }
}

function novoRack(state: MatchState, breaker: PlayerIndex): MatchState {
  return {
    turn: breaker,
    groups: { open: true },
    pocketed: [],
    broken: false,
    breaker,
    ballInHand: { active: false },
    consecutiveFouls: state.consecutiveFouls,
    pending: null,
    winner: null,
    ending: null,
  }
}

/**
 * Empate técnico: ninguém tenta vencer.
 *
 * Pela WPA, quem quebrou o rack quebra de novo.
 */
export const stalemate = (state: MatchState): MatchState => novoRack(state, state.breaker)

/** Desistência ou W.O. por tempo. */
export function forfeit(state: MatchState, quemDesiste: PlayerIndex): MatchState {
  return { ...state, winner: otherPlayer(quemDesiste), ending: { kind: 'forfeit' } }
}
