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
  /**
   * Decisão que precisa ser tomada antes da próxima tacada, se houver.
   *
   * Devolve `null` na modalidade que não tem nenhuma. Quem chama DEVE consultar
   * isto entre tacadas: mandar jogar com decisão pendente é erro, e as regras
   * lançam em vez de escolher sozinhas — escolher seria tirar do jogador um
   * direito que a regra lhe dá.
   */
  pendingOf(state: TState): PendingDecision | null
  /**
   * O jogador da vez pode reposicionar a branca?
   *
   * `null` quando não; a região quando sim. Precisa estar no contrato comum
   * porque quem coloca a bola é a interface, e ela não conhece o estado
   * concreto de nenhuma modalidade.
   *
   * Isto também decide o que vai para o replay: uma posição escolhida pelo
   * jogador é ENTRADA, e entrada não gravada faz a verificação reproduzir
   * outra partida.
   */
  ballInHandOf(state: TState): BallInHandRegion | null
  /**
   * O jogador da vez precisa declarar bola e caçapa nesta tacada?
   *
   * A WPA exige na bola 8: dizer ANTES em qual buraco ela vai cair, para
   * ninguém ganhar de sorte. Sem declarar, encaçapar a 8 é falta — e falta na
   * 8 é DERROTA.
   *
   * Precisa estar no contrato comum porque quem declara é a interface, e ela
   * não conhece o estado concreto de nenhuma modalidade.
   */
  callRequiredOf(state: TState): boolean
  /** Aplica a escolha do jogador e libera a próxima tacada. */
  resolve(state: TState, optionIndex: number): DecisionOutcome<TState>
  /** Desistência ou W.O. por tempo. */
  forfeit(state: TState, quemDesiste: 0 | 1): TState
  /** Quem venceu, se a partida acabou. */
  winnerOf(state: TState): 0 | 1 | null
  /** Resumo para a interface, sem ela conhecer o formato interno. */
  summarize(state: TState): MatchSummary
}

/**
 * Escolha aberta entre tacadas, no vocabulário comum.
 *
 * As opções vêm como índices para caberem num byte do replay. O texto serve à
 * interface; o índice é o que fica gravado e o que a verificação reproduz.
 * A ORDEM das opções é parte do formato: trocá-la faria replays antigos
 * reproduzirem outra escolha.
 */
export type PendingDecision = {
  chooser: 0 | 1
  /** Identificador estável da situação, para a interface explicar. */
  kind: string
  /** Rótulos das opções, na ordem em que são numeradas. */
  options: readonly string[]
}

/**
 * Onde a branca pode ser colocada.
 *
 * `kitchen` é a área atrás da linha da cabeça, para onde a WPA manda a bola
 * depois de falta na quebra. `anywhere` é qualquer ponto livre da mesa.
 */
export type BallInHandRegion = 'anywhere' | 'kitchen'

export type DecisionOutcome<TState> = {
  state: TState
  /**
   * A escolha exige montar o triângulo de novo.
   *
   * Precisa ser explícito porque o estado de REGRAS e o estado FÍSICO da mesa
   * são separados: as regras zeram as bolas encaçapadas, mas as bolas em si
   * continuam onde pararam até alguém rearmar. Inferir isso do estado seria
   * frágil, e errar significa jogo e verificador divergirem.
   */
  rerack: boolean
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

/**
 * Ordem canônica das escolhas pós-quebra.
 *
 * NÃO REORDENAR. O índice nesta lista é o que vai gravado no replay; mudar a
 * ordem faria toda partida antiga ser reproduzida com outra escolha, e a
 * auditoria passaria a apontar vencedores errados sem nada acusar.
 */
const BREAK_CHOICES: readonly eightballTypes.BreakChoice[] = [
  'accept',
  'rerack-self',
  'rerack-opponent',
  'respot-eight',
]

const BREAK_CHOICES_LABELS: readonly string[] = [
  'Aceitar a mesa',
  'Quebrar de novo',
  'Devolver a quebra',
  'Recolocar a 8',
]

const eightballMode: GameMode<
  eightballTypes.MatchState,
  eightballTypes.ShotOutcome,
  eightballTypes.ShotRuling
> = {
  info: GAME_MODE_INFO.eightball,
  create: (breaker) => eightballTypes.createMatch(breaker),
  judge: (state, outcome) => eightball.judgeShot(state, outcome),
  play: (state, outcome) => eightball.playShot(state, outcome),
  pendingOf: (state) => {
    const p = state.pending
    if (!p) return null
    return { chooser: p.chooser, kind: p.kind, options: BREAK_CHOICES_LABELS }
  },
  ballInHandOf: (state) => (state.ballInHand.active ? state.ballInHand.region : null),
  callRequiredOf: (state) => eightball.callRequired(state),
  resolve: (state, optionIndex) => {
    const escolha = BREAK_CHOICES[optionIndex]
    if (!escolha) {
      throw new Error(`Opção ${optionIndex} não existe para esta decisão.`)
    }
    const novo = eightball.resolveChoice(state, escolha)
    // Reracking se as regras rearmaram o rack: mesa cheia de novo e por
    // quebrar. `accept` e `respot-eight` seguem na mesa como está.
    return { state: novo, rerack: !novo.broken && novo.pocketed.length === 0 }
  },
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
  // A sinuca brasileira não abre escolha ao adversário em momento nenhum: toda
  // consequência de falta é automática (bola devolvida, pontos ao rival).
  pendingOf: () => null,
  resolve: () => {
    throw new Error('A sinuca brasileira não tem decisões pendentes.')
  },
  // A sinuca não tem a regra da cozinha: falta dá a bola na mão em qualquer
  // ponto livre.
  ballInHandOf: (state) => (state.ballInHand ? 'anywhere' : null),
  // A sinuca brasileira não tem bola declarada: a bola da vez é imposta pela
  // ordem crescente, então não há o que escolher.
  callRequiredOf: () => false,
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
