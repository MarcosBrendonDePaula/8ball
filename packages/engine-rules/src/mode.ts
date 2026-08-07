/**
 * Registro de modalidades.
 *
 * O resto do sistema — servidor, lobby, interface — fala SÓ com esta
 * interface. Nada fora daqui precisa saber se a partida é 8-Ball ou sinuca
 * brasileira, e acrescentar uma terceira modalidade não deve exigir mexer em
 * nenhum deles.
 *
 * O preço dessa indireção é que os tipos ficam genéricos (`unknown` no estado
 * concreto). Vale a pena: sem ela, cada modalidade nova espalharia um `if` por
 * todo o servidor, e é assim que um projeto fica impossível de manter.
 */

import * as eightball from './eightball/rules'
import * as eightballTypes from './eightball/types'
import * as sinuca from './sinuca/rules'
import * as sinucaTypes from './sinuca/types'

export type GameModeId = 'eightball' | 'sinuca'

export const GAME_MODES: readonly GameModeId[] = ['eightball', 'sinuca']

/** Metadados para a interface mostrar as opções sem conhecer as regras. */
export type GameModeInfo = {
  id: GameModeId
  name: string
  description: string
  /** Quantas bolas, sem contar a branca. */
  ballCount: number
}

export const GAME_MODE_INFO: Record<GameModeId, GameModeInfo> = {
  eightball: {
    id: 'eightball',
    name: '8-Ball',
    description: 'Lisas contra listradas. Quem limpar o grupo e encaçapar a 8 vence.',
    ballCount: 15,
  },
  sinuca: {
    id: 'sinuca',
    name: 'Sinuca brasileira',
    description: 'Sete coloridas em ordem crescente. Vence quem fizer mais pontos.',
    ballCount: 7,
  },
}

/**
 * Contrato que toda modalidade cumpre.
 *
 * `TState` e `TOutcome` ficam genéricos porque cada jogo tem os seus; quem
 * chama trata como opaco e só repassa entre as funções.
 */
export type GameMode<TState = unknown, TOutcome = unknown, TRuling = unknown> = {
  info: GameModeInfo
  /** Estado inicial de uma partida. */
  create(breaker: 0 | 1): TState
  /** Julga a tacada sem alterar nada. */
  judge(state: TState, outcome: TOutcome): TRuling
  /** Julga e avança para o estado da próxima tacada. */
  play(state: TState, outcome: TOutcome): { state: TState; ruling: TRuling }
  /** Desistência ou W.O. por tempo. */
  forfeit(state: TState, quemDesiste: 0 | 1): TState
  /** Quem venceu, se a partida acabou. */
  winnerOf(state: TState): 0 | 1 | null
  /** Resumo para a interface, sem ela conhecer o formato interno. */
  summarize(state: TState): MatchSummary
}

/**
 * Visão da partida que serve para qualquer modalidade.
 *
 * É o que o placar da interface consome. Cada jogo preenche do seu jeito: o
 * 8-Ball em bolas restantes, a sinuca em pontos.
 */
export type MatchSummary = {
  turn: 0 | 1
  /** Texto curto do que está em jogo agora. */
  status: string
  /** Placar, quando a modalidade tem um. */
  score: [number, number] | null
  /** Ids ainda na mesa. */
  onTable: number[]
  finished: boolean
  winner: 0 | 1 | null
}

// -------------------------------------------------------------- 8-Ball

const eightballMode: GameMode<
  eightballTypes.MatchState,
  eightballTypes.ShotOutcome,
  eightballTypes.ShotRuling
> = {
  info: GAME_MODE_INFO.eightball,
  create: (breaker) => eightballTypes.createMatch(breaker),
  judge: (state, outcome) => eightball.judgeShot(state, outcome),
  play: (state, outcome) => eightball.playShot(state, outcome),
  forfeit: (state, quem) => eightball.forfeit(state, quem),
  winnerOf: (state) => state.winner,
  summarize: (state) => ({
    turn: state.turn,
    status: descreverEightball(state),
    score: null,
    onTable: bolasNaMesaEightball(state),
    finished: state.winner !== null,
    winner: state.winner,
  }),
}

function descreverEightball(state: eightballTypes.MatchState): string {
  if (state.winner !== null) return `Jogador ${state.winner + 1} venceu`
  if (!state.broken) return 'Quebra'
  if (state.groups.open) return 'Mesa aberta'

  const faltam = eightballTypes.remainingFor(state, state.turn)
  return faltam.length === 0 ? 'Na bola 8' : `Faltam ${faltam.length}`
}

function bolasNaMesaEightball(state: eightballTypes.MatchState): number[] {
  const todas = [...eightballTypes.SOLIDS, eightballTypes.EIGHT_BALL, ...eightballTypes.STRIPES]
  return todas.filter((id) => !state.pocketed.includes(id))
}

// ------------------------------------------------------- sinuca brasileira

const sinucaMode: GameMode<
  sinucaTypes.SinucaState,
  sinucaTypes.SinucaOutcome,
  sinucaTypes.SinucaRuling
> = {
  info: GAME_MODE_INFO.sinuca,
  create: (breaker) => sinucaTypes.createSinucaMatch(breaker),
  judge: (state, outcome) => sinuca.judgeSinucaShot(state, outcome),
  play: (state, outcome) => sinuca.playSinucaShot(state, outcome),
  forfeit: (state, quem) => sinuca.forfeitSinuca(state, quem),
  winnerOf: (state) => state.winner,
  summarize: (state) => {
    const alvo = sinucaTypes.ballOnTurn(state)
    return {
      turn: state.turn,
      status:
        state.winner !== null
          ? `Jogador ${state.winner + 1} venceu`
          : alvo === null
            ? 'Mesa vazia'
            : `Bola da vez: ${sinucaTypes.BALL_NAMES[alvo] ?? alvo}`,
      score: state.score,
      onTable: state.onTable,
      finished: state.winner !== null,
      winner: state.winner,
    }
  },
}

// -------------------------------------------------------------- registro

const REGISTRO: Record<GameModeId, GameMode<never, never, never>> = {
  eightball: eightballMode as GameMode<never, never, never>,
  sinuca: sinucaMode as GameMode<never, never, never>,
}

/**
 * Busca a modalidade pelo id.
 *
 * Lança em id desconhecido em vez de cair para um padrão: uma sala com
 * modalidade inválida é bug, e resolver silenciosamente faria os dois
 * jogadores jogarem jogos diferentes.
 */
export function getGameMode(id: GameModeId): GameMode<never, never, never> {
  const modo = REGISTRO[id]
  if (!modo) throw new Error(`Modalidade desconhecida: ${id}`)
  return modo
}

export const isGameModeId = (value: string): value is GameModeId =>
  (GAME_MODES as readonly string[]).includes(value)
