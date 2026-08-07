/**
 * Vocabulário da sinuca brasileira ("regra de bolinha").
 *
 * Jogo diferente do 8-Ball: sete bolas coloridas numeradas, pontuação por bola
 * em vez de grupos, e vitória por placar em vez de encaçapar uma bola final.
 *
 * Baseado nas regras da CBBS. As fontes divergem em detalhes de mesa de bar,
 * então os pontos onde há variação estão em `SinucaRuleSet` em vez de fixos no
 * código.
 */

export const CUE_BALL = 0

/** As sete coloridas, na ordem de valor. */
export const COLORED_BALLS = [1, 2, 3, 4, 5, 6, 7] as const

/** Nome de cada bola, para a interface. */
export const BALL_NAMES: Record<number, string> = {
  1: 'vermelha',
  2: 'amarela',
  3: 'verde',
  4: 'marrom',
  5: 'azul',
  6: 'rosa',
  7: 'preta',
}

/** O número da bola é o valor dela em pontos. */
export const valueOf = (ball: number): number =>
  ball >= 1 && ball <= 7 ? ball : 0

export type PlayerIndex = 0 | 1

export type Pocket = 0 | 1 | 2 | 3 | 4 | 5

/**
 * Ajustes de regra.
 *
 * Sinuca de bar varia bastante de lugar para lugar; estas são as variações que
 * mais aparecem e que mudam o jogo de verdade.
 */
export type SinucaRuleSet = {
  /** Pontos que o adversário ganha a cada falta. */
  foulPoints: number
  /**
   * Depois de encaçapar a bola da vez, o jogador declara uma bola LIVRE.
   * Acertando, pontua; errando, leva a penalidade.
   */
  freeBallAfterPot: boolean
  /**
   * Encerra a partida quando a diferença de pontos torna impossível a virada.
   * Sem isso, a partida arrasta até a última bola mesmo decidida.
   */
  endOnUnreachableScore: boolean
}

export const DEFAULT_SINUCA_RULES: SinucaRuleSet = {
  foulPoints: 7,
  freeBallAfterPot: true,
  endOnUnreachableScore: true,
}

export type SinucaFoul =
  | 'cue-ball-pocketed'
  | 'cue-ball-off-table'
  | 'ball-off-table'
  | 'no-contact'
  | 'wrong-ball-first'
  | 'no-rail-after-contact'
  | 'free-ball-missed'

export type SinucaEnding =
  | { kind: 'all-balls-potted' }
  | { kind: 'score-unreachable' }
  | { kind: 'forfeit' }

export type SinucaState = {
  turn: PlayerIndex
  /** Placar dos dois jogadores. */
  score: [number, number]
  /** Bolas ainda na mesa, em ordem crescente. */
  onTable: number[]
  /** Bola livre declarada para esta tacada, se houver. */
  nominated: number | null
  /** Jogador com bola na mão após falta. */
  ballInHand: boolean
  broken: boolean
  winner: PlayerIndex | null
  ending: SinucaEnding | null
}

/**
 * O que a física relatou.
 *
 * Mesma ideia do 8-Ball: a física produz, as regras consomem.
 */
export type SinucaOutcome = {
  firstContact: number | null
  pocketed: number[]
  offTable: number[]
  railAfterContact: boolean
  /** Bola que o jogador declarou como livre, quando tem esse direito. */
  nominated: number | null
}

export type SinucaRuling = {
  foul: SinucaFoul | null
  /** Pontos que o jogador da vez marcou nesta tacada. */
  scored: number
  /** Pontos dados ao adversário pela falta. */
  penalty: number
  continues: boolean
  /** Bolas encaçapadas indevidamente, que voltam para a mesa. */
  respot: number[]
  winner: PlayerIndex | null
  ending: SinucaEnding | null
}

export const otherPlayer = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0)

/**
 * A bola da vez é sempre a MENOR ainda na mesa.
 *
 * É a diferença central em relação ao 8-Ball: não há grupo por jogador; os
 * dois disputam a mesma sequência.
 */
export const ballOnTurn = (state: SinucaState): number | null =>
  state.onTable.length > 0 ? Math.min(...state.onTable) : null

/** Soma de tudo que ainda dá para marcar. */
export const pointsRemaining = (state: SinucaState): number =>
  state.onTable.reduce((soma, ball) => soma + valueOf(ball), 0)

/**
 * A partida já está decidida?
 *
 * Se nem marcando tudo o que resta o perdedor alcança o líder, insistir só
 * gasta o tempo dos dois.
 */
export function isDecided(state: SinucaState): boolean {
  const [a, b] = state.score
  return Math.abs(a - b) > pointsRemaining(state)
}

export function createSinucaMatch(breaker: PlayerIndex = 0): SinucaState {
  return {
    turn: breaker,
    score: [0, 0],
    onTable: [...COLORED_BALLS],
    nominated: null,
    ballInHand: false,
    broken: false,
    winner: null,
    ending: null,
  }
}
