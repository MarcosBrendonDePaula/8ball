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
  /**
   * A bola que esta tacada é OBRIGADA a acertar primeiro, se a modalidade
   * impuser uma.
   *
   * `null` quando não há uma só — no 8-Ball o alvo é um grupo inteiro, e
   * apontar uma bola dele seria mentir para o jogador. A sinuca impõe a menor
   * da mesa, e sem isto a interface não tem como dizer qual é: as sete
   * coloridas parecem igualmente jogáveis.
   *
   * Fica no contrato comum porque quem mostra é a interface, que não conhece o
   * estado concreto de nenhuma modalidade.
   */
  targetBallOf(state: TState): number | null
  /** Aplica a escolha do jogador e libera a próxima tacada. */
  resolve(state: TState, optionIndex: number): DecisionOutcome<TState>
  /** Desistência ou W.O. por tempo. */
  forfeit(state: TState, quemDesiste: 0 | 1): TState
  /** Quem venceu, se a partida acabou. */
  winnerOf(state: TState): 0 | 1 | null
  /**
   * Quem está na frente AGORA, se a partida tivesse de acabar aqui.
   *
   * `null` quando ninguém está — e aí não há como decidir sem inventar.
   *
   * Existe por causa de um free-roll: o replay tem teto de tacadas, e ao
   * estourar a partida era ANULADA com reembolso. Quem estava perdendo então
   * simplesmente parava de jogar — cada prazo estourado consome uma tacada
   * nula, e em 37 minutos o teto chegava e o dinheiro voltava. O mesmo ataque
   * do prazo do escrow, por outra porta.
   *
   * Decidir pelo estado remove o incentivo: parar de jogar não pontua, e quem
   * não pontua perde.
   */
  standingWinner(state: TState): 0 | 1 | null
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
  /**
   * As opções VÁLIDAS para esta situação, cada uma com o índice canônico.
   *
   * O índice é o que fica gravado no replay, e a lista canônica não pode ser
   * reordenada nem filtrada — por isso ele viaja junto do rótulo em vez de ser
   * a posição no array.
   *
   * Antes disto a interface oferecia as quatro opções nas duas situações, e
   * três delas mentiam: escolher "Aceitar a mesa" na 8 da quebra rearmava o
   * rack, porque `resolveChoice` manda tudo que não é `respot-eight` para o
   * `default`.
   */
  options: readonly { index: number; label: string }[]
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
   * Bolas que a escolha manda de volta ao ponto de pé.
   *
   * Pelo mesmo motivo de `rerack`: o estado de REGRAS e o da MESA são
   * separados, e as regras não movem bola nenhuma. Sem isto, escolher
   * "recolocar a 8" tirava a 8 da lista de encaçapadas mas a deixava fora da
   * mesa física — e quem limpasse o grupo nunca mais conseguia tocá-la. Toda
   * tacada virava falta por falta de contato, para sempre.
   */
  respot: number[]
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

/**
 * Quais índices canônicos valem em cada situação.
 *
 * A WPA dá DUAS opções quando a 8 cai na quebra (4.3e) e TRÊS quando a quebra
 * é irregular (4.3d). Oferecer as quatro nas duas fazia o jogador escolher algo
 * que o motor de regras interpretava como outra coisa.
 */
const OPCOES_POR_SITUACAO: Record<string, readonly number[]> = {
  'eight-on-break': [3, 1], // recolocar a 8, ou quebrar de novo
  'illegal-break': [0, 1, 2], // aceitar, quebrar de novo, devolver a quebra
}

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

    const validas = OPCOES_POR_SITUACAO[p.kind] ?? BREAK_CHOICES.map((_, i) => i)
    return {
      chooser: p.chooser,
      kind: p.kind,
      options: validas.map((index) => ({ index, label: BREAK_CHOICES_LABELS[index]! })),
    }
  },
  ballInHandOf: (state) => (state.ballInHand.active ? state.ballInHand.region : null),
  callRequiredOf: (state) => eightball.callRequired(state),
  // O alvo do 8-Ball é o grupo inteiro, não uma bola. Apontar uma delas faria
  // o jogador acreditar numa obrigação que a regra não impõe.
  targetBallOf: () => null,
  resolve: (state, optionIndex) => {
    const escolha = BREAK_CHOICES[optionIndex]
    if (!escolha) {
      throw new Error(`Opção ${optionIndex} não existe para esta decisão.`)
    }
    const novo = eightball.resolveChoice(state, escolha)

    // Rerack quando as regras rearmaram: mesa cheia de novo e por quebrar.
    const rerack = !novo.broken && novo.pocketed.length === 0

    // A 8 volta ao ponto de pé quando ela saiu da lista de encaçapadas sem
    // haver rerack — que é exatamente o caso de `respot-eight`.
    const voltou =
      !rerack &&
      state.pocketed.includes(eightballTypes.EIGHT_BALL) &&
      !novo.pocketed.includes(eightballTypes.EIGHT_BALL)

    return { state: novo, rerack, respot: voltou ? [eightballTypes.EIGHT_BALL] : [] }
  },
  forfeit: (state, quem) => eightball.forfeit(state, quem),
  winnerOf: (state) => state.winner,
  // Menos bolas do próprio grupo na mesa. Com a mesa aberta ninguém tem grupo,
  // e aí não há do que medir.
  standingWinner: (state) => {
    if (state.groups.open) return null
    const faltam: [number, number] = [
      eightballTypes.remainingFor(state, 0).length,
      eightballTypes.remainingFor(state, 1).length,
    ]
    if (faltam[0] === faltam[1]) return null
    return faltam[0] < faltam[1] ? 0 : 1
  },
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
  // Mesma conta de `alvoDaTacada` nas regras: a bola livre declarada substitui
  // a da vez. Duplicá-la aqui deixaria a mesa destacando uma bola e o
  // julgamento cobrando outra.
  targetBallOf: (state) => state.nominated ?? sinucaTypes.ballOnTurn(state),
  forfeit: (state, quem) => sinuca.forfeitSinuca(state, quem),
  winnerOf: (state) => state.winner,
  // A sinuca já é decidida por pontos: quem está na frente está na frente.
  standingWinner: (state) => {
    if (state.score[0] === state.score[1]) return null
    return state.score[0] > state.score[1] ? 0 : 1
  },
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
      // Pelo FIM registrado, não pelo vencedor: um empate encerra a partida
      // sem vencedor, e olhar só o `winner` deixava a mesa vazia esperando uma
      // tacada impossível — a falta por falta de contato era inevitável e os 7
      // pontos de penalidade decidiam por quem estava na vez.
      finished: state.ending !== null,
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
