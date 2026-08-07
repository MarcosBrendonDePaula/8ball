/**
 * Vocabulário das regras do 8-Ball.
 *
 * Baseado nas World Standardized Rules da WPA, com um conjunto de opções para
 * as variações de bar — que é o que a maioria das pessoas conhece por "regra
 * de sinuca" e o que faz sentido para uma partida casual.
 *
 * Separado da física de propósito: a engine sabe onde as bolas pararam, e é
 * este módulo que diz o que isso SIGNIFICA.
 */

export const SOLIDS = [1, 2, 3, 4, 5, 6, 7] as const
export const STRIPES = [9, 10, 11, 12, 13, 14, 15] as const
export const EIGHT_BALL = 8
export const CUE_BALL = 0

export type Group = 'solids' | 'stripes'

/** Antes da definição de grupos, a mesa está aberta para os dois. */
export type GroupAssignment = { open: true } | { open: false; first: Group; second: Group }

export type PlayerIndex = 0 | 1

export type Pocket = 0 | 1 | 2 | 3 | 4 | 5

// -------------------------------------------------------------- variantes

/**
 * Ajustes de regra.
 *
 * A WPA exige declarar bola e caçapa em TODA tacada. Numa partida casual isso
 * é um atrito enorme na interface, e a maioria das mesas de bar não cobra.
 * Por isso é configurável — mas o padrão do projeto está declarado abaixo e a
 * escolha é explícita, não acidental.
 */
export type RuleSet = {
  /** Quando o jogador precisa declarar bola e caçapa. */
  callShot: 'always' | 'eight-only' | 'never'
  /**
   * Quebra válida: encaçapar alguma bola OU levar este número de bolas à
   * tabela. Abaixo disso, o adversário escolhe o que fazer.
   */
  breakMinBallsToRail: number
  /**
   * Falta na quebra restringe a bola na mão à "cozinha" (atrás da linha da
   * cabeça). Fora da quebra, bola na mão é sempre em qualquer lugar.
   */
  kitchenAfterBreakScratch: boolean
  /**
   * Encaçapar a 8 na quebra derrota?
   *
   * Pela WPA, NÃO: o quebrador escolhe entre recolocar a 8 e seguir, ou
   * quebrar de novo. Muitas mesas de bar tratam como derrota.
   */
  eightOnBreakLoses: boolean
  /** Três faltas seguidas do mesmo jogador entregam a partida. */
  threeFoulRule: boolean
}

/** Padrão do projeto: WPA com declaração só na 8. */
export const DEFAULT_RULES: RuleSet = {
  callShot: 'eight-only',
  breakMinBallsToRail: 4,
  kitchenAfterBreakScratch: true,
  eightOnBreakLoses: false,
  threeFoulRule: false,
}

/** Fiel à WPA. */
export const WPA_RULES: RuleSet = {
  callShot: 'always',
  breakMinBallsToRail: 4,
  kitchenAfterBreakScratch: true,
  eightOnBreakLoses: false,
  threeFoulRule: true,
}

/** Regra de bar: sem declaração, quebra sempre vale, 8 na quebra perde. */
export const BAR_RULES: RuleSet = {
  callShot: 'never',
  breakMinBallsToRail: 0,
  kitchenAfterBreakScratch: false,
  eightOnBreakLoses: true,
  threeFoulRule: false,
}

// ----------------------------------------------------------------- faltas

export type FoulReason =
  | 'cue-ball-pocketed'
  | 'cue-ball-off-table'
  | 'no-contact'
  | 'wrong-ball-first'
  | 'eight-ball-first-illegal'
  | 'no-rail-after-contact'
  | 'ball-off-table'
  | 'no-call'
  | 'wrong-ball-called'

/** Onde a bola na mão pode ser colocada. */
export type BallInHand =
  | { active: false }
  /** Em qualquer ponto livre da mesa. */
  | { active: true; region: 'anywhere' }
  /** Atrás da linha da cabeça, após falta na quebra. */
  | { active: true; region: 'kitchen' }

/**
 * Decisão pendente entre tacadas.
 *
 * A WPA dá escolhas ao adversário em duas situações, e nenhuma pode ser
 * resolvida automaticamente sem tirar do jogador um direito que ele tem.
 */
export type PendingChoice =
  | { kind: 'eight-on-break'; chooser: PlayerIndex }
  | { kind: 'illegal-break'; chooser: PlayerIndex }

export type BreakChoice = 'accept' | 'rerack-self' | 'rerack-opponent' | 'respot-eight'

export type MatchState = {
  turn: PlayerIndex
  groups: GroupAssignment
  /** Ids já encaçapados e fora da mesa. */
  pocketed: number[]
  broken: boolean
  /** Quem quebrou este rack. Volta a quebrar em caso de empate técnico. */
  breaker: PlayerIndex
  ballInHand: BallInHand
  /** Faltas seguidas por jogador, para a regra das três faltas. */
  consecutiveFouls: [number, number]
  /** Escolha aguardando o jogador, se houver. */
  pending: PendingChoice | null
  winner: PlayerIndex | null
  ending: MatchEnding | null
}

export type MatchEnding =
  | { kind: 'eight-ball-potted' }
  | { kind: 'eight-ball-early' }
  | { kind: 'eight-ball-wrong-pocket' }
  | { kind: 'eight-ball-with-foul'; foul: FoulReason }
  | { kind: 'eight-ball-off-table' }
  | { kind: 'three-fouls' }
  | { kind: 'forfeit' }

/**
 * O que a física relatou sobre uma tacada.
 *
 * É a ponte entre os dois módulos: a física produz isto, as regras consomem.
 */
export type ShotOutcome = {
  /** Primeira bola que a branca tocou, ou null. */
  firstContact: number | null
  /** Encaçapadas nesta tacada, na ordem. */
  pocketed: number[]
  /** Bolas que saíram da mesa (puladas). */
  offTable: number[]
  /**
   * Quantas bolas NUMERADAS tocaram alguma tabela. Usado só na quebra, para
   * decidir se ela foi válida.
   */
  ballsToRail: number
  /** Alguma bola (inclusive a branca) tocou a tabela após o primeiro contato. */
  railAfterContact: boolean
  /** Caçapa onde a 8 caiu, se caiu. */
  eightBallPocket: Pocket | null
  /** Declaração do jogador antes da tacada. */
  called: { ball: number; pocket: Pocket } | null
}

export type ShotRuling = {
  foul: FoulReason | null
  continues: boolean
  groups: GroupAssignment
  winner: PlayerIndex | null
  ending: MatchEnding | null
  /** Escolha que o adversário passa a ter. */
  pending: PendingChoice | null
  /** A 8 precisa voltar para a mesa (encaçapada numa quebra legal). */
  respotEight: boolean
}

// ------------------------------------------------------------- utilidades

export const otherPlayer = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0)

export const groupOf = (ball: number): Group | null => {
  if (ball >= 1 && ball <= 7) return 'solids'
  if (ball >= 9 && ball <= 15) return 'stripes'
  return null
}

export function groupFor(groups: GroupAssignment, player: PlayerIndex): Group | null {
  if (groups.open) return null
  return player === 0 ? groups.first : groups.second
}

/** Ids que faltam para o jogador limpar o grupo. */
export function remainingFor(state: MatchState, player: PlayerIndex): number[] {
  const grupo = groupFor(state.groups, player)
  if (!grupo) return []

  const doGrupo = grupo === 'solids' ? SOLIDS : STRIPES
  return doGrupo.filter((id) => !state.pocketed.includes(id))
}

/** O jogador já pode mirar na 8? */
export const canShootEight = (state: MatchState, player: PlayerIndex): boolean =>
  !state.groups.open && remainingFor(state, player).length === 0

export function createMatch(breaker: PlayerIndex = 0): MatchState {
  return {
    turn: breaker,
    groups: { open: true },
    pocketed: [],
    broken: false,
    breaker,
    ballInHand: { active: false },
    consecutiveFouls: [0, 0],
    pending: null,
    winner: null,
    ending: null,
  }
}
