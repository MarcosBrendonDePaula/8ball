import {
  CUE_BALL,
  DEFAULT_SINUCA_RULES,
  ballOnTurn,
  otherPlayer,
  valueOf,
  type PlayerIndex,
  type SinucaEnding,
  type SinucaFoul,
  type SinucaOutcome,
  type SinucaRuleSet,
  type SinucaRuling,
  type SinucaState,
} from './types'

/**
 * Regras da sinuca brasileira.
 *
 * Funções PURAS, como no 8-Ball: mesmo par (estado, tacada) sempre produz o
 * mesmo julgamento, para servidor e cliente não discordarem.
 *
 * O que torna este jogo diferente do 8-Ball, e que o código precisa refletir:
 *
 *   - Não há grupos. Os dois disputam a MESMA sequência, da menor para a maior.
 *   - Pontua-se por bola, e a partida se decide no PLACAR — não em encaçapar
 *     uma bola final.
 *   - Falta dá pontos ao adversário, não só passa a vez.
 *   - Bola encaçapada indevidamente VOLTA para a mesa. No 8-Ball, só a 8 volta.
 */

export function judgeSinucaShot(
  state: SinucaState,
  outcome: SinucaOutcome,
  rules: SinucaRuleSet = DEFAULT_SINUCA_RULES,
): SinucaRuling {
  if (state.winner !== null) throw new Error('A partida já terminou.')

  const jogador = state.turn
  const adversario = otherPlayer(jogador)

  const alvo = alvoDaTacada(state, rules)
  const falta = detectarFalta(state, outcome, alvo)
  const caidas = coloridasEncaçapadas(outcome)

  // Falta anula os pontos e devolve tudo à mesa; sem falta, sai só o alvo.
  const alvoCaiu = !falta && alvo !== null && outcome.pocketed.includes(alvo)

  const scored = alvoCaiu ? valueOf(alvo) : 0
  const penalty = falta ? rules.foulPoints : 0
  const respot = falta ? caidas : caidas.filter((id) => id !== alvo)

  const placar: [number, number] = [...state.score]
  placar[jogador] += scored
  placar[adversario] += penalty

  const naMesa = alvoCaiu ? state.onTable.filter((id) => id !== alvo) : state.onTable

  return {
    foul: falta,
    scored,
    penalty,
    continues: alvoCaiu,
    respot,
    ...fimDePartida(placar, naMesa, rules),
  }
}

/**
 * Qual bola era alvo legal desta tacada.
 *
 * Normalmente é a menor da mesa. Se o jogador declarou bola livre — direito
 * que nasce de ter encaçapado a da vez —, o alvo passa a ser a declarada.
 */
function alvoDaTacada(state: SinucaState, rules: SinucaRuleSet): number | null {
  if (rules.freeBallAfterPot && state.nominated !== null) return state.nominated
  return ballOnTurn(state)
}

function detectarFalta(
  state: SinucaState,
  outcome: SinucaOutcome,
  alvo: number | null,
): SinucaFoul | null {
  if (outcome.pocketed.includes(CUE_BALL)) return 'cue-ball-pocketed'
  if (outcome.offTable.includes(CUE_BALL)) return 'cue-ball-off-table'
  if (outcome.offTable.some((id) => id !== CUE_BALL)) return 'ball-off-table'

  if (outcome.firstContact === null) return 'no-contact'

  if (alvo !== null && outcome.firstContact !== alvo) {
    // Errar a bola LIVRE tem nome próprio: o jogador escolheu correr o risco,
    // e a mensagem precisa deixar isso claro em vez de dizer "bola errada".
    return state.nominated !== null ? 'free-ball-missed' : 'wrong-ball-first'
  }

  if (outcome.pocketed.length === 0 && !outcome.railAfterContact) {
    return 'no-rail-after-contact'
  }

  return null
}

const coloridasEncaçapadas = (outcome: SinucaOutcome): number[] =>
  outcome.pocketed.filter((id) => id !== CUE_BALL)

/**
 * A partida acabou?
 *
 * Dois caminhos: acabaram as bolas, ou a diferença de pontos passou do que
 * ainda dá para marcar. O segundo evita arrastar uma partida já decidida.
 */
function fimDePartida(
  placar: [number, number],
  naMesa: number[],
  rules: SinucaRuleSet,
): { winner: PlayerIndex | null; ending: SinucaEnding | null } {
  if (naMesa.length === 0) {
    return { winner: vencedorPor(placar), ending: { kind: 'all-balls-potted' } }
  }

  if (rules.endOnUnreachableScore) {
    const disponivel = naMesa.reduce((soma, id) => soma + valueOf(id), 0)
    if (Math.abs(placar[0] - placar[1]) > disponivel) {
      return { winner: vencedorPor(placar), ending: { kind: 'score-unreachable' } }
    }
  }

  return { winner: null, ending: null }
}

function vencedorPor(placar: [number, number]): PlayerIndex | null {
  if (placar[0] === placar[1]) return null
  return placar[0] > placar[1] ? 0 : 1
}

/**
 * Aplica o julgamento e devolve o estado da próxima tacada.
 *
 * Separado do julgamento porque a interface precisa MOSTRAR o que aconteceu
 * antes de avançar a vez.
 */
export function applySinucaRuling(
  state: SinucaState,
  outcome: SinucaOutcome,
  ruling: SinucaRuling,
  rules: SinucaRuleSet = DEFAULT_SINUCA_RULES,
): SinucaState {
  const jogador = state.turn
  const adversario = otherPlayer(jogador)

  const score: [number, number] = [...state.score]
  score[jogador] += ruling.scored
  score[adversario] += ruling.penalty

  // Sai da mesa só o que foi encaçapado legalmente; o resto volta ao lugar.
  const removidas = outcome.pocketed.filter(
    (id) => id !== CUE_BALL && !ruling.respot.includes(id),
  )

  return {
    turn: ruling.continues ? jogador : adversario,
    score,
    onTable: state.onTable.filter((id) => !removidas.includes(id)),
    // O direito à bola livre nasce de encaçapar a da vez e vale só a próxima.
    nominated: ruling.continues && rules.freeBallAfterPot ? outcome.nominated : null,
    ballInHand: ruling.foul !== null,
    broken: true,
    winner: ruling.winner,
    ending: ruling.ending,
  }
}

export function playSinucaShot(
  state: SinucaState,
  outcome: SinucaOutcome,
  rules: SinucaRuleSet = DEFAULT_SINUCA_RULES,
): { state: SinucaState; ruling: SinucaRuling } {
  const ruling = judgeSinucaShot(state, outcome, rules)
  return { state: applySinucaRuling(state, outcome, ruling, rules), ruling }
}

export function forfeitSinuca(state: SinucaState, quemDesiste: PlayerIndex): SinucaState {
  return { ...state, winner: otherPlayer(quemDesiste), ending: { kind: 'forfeit' } }
}
