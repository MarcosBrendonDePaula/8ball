import { z } from 'zod'

/**
 * Contrato de mensagens entre cliente e servidor.
 *
 * Este pacote é a única fonte da verdade do protocolo — os dois lados importam
 * daqui e validam com os mesmos schemas. Toda mensagem que chega do cliente é
 * parseada antes de ser olhada; nada de `as` em payload de rede.
 *
 * Valores trafegam como STRING de unidades inteiras (lamports), nunca como
 * number. `number` em JS perde precisão acima de 2^53.
 *
 * PONTO CENTRAL DO DESENHO: o servidor não move dinheiro. Quem assina o
 * depósito é a carteira do jogador. O servidor apenas LÊ a chain e confirma
 * (docs/TDD.md §6.4). Por isso criar uma mesa tem dois passos — reservar e
 * confirmar — com a assinatura da carteira no meio.
 */

/** SOL usa 9 casas (1 SOL = 1e9 lamports). */
export const DECIMALS = 9

/** Estados da sala. Espelha a máquina de estados do TDD §5. */
export const RoomState = z.enum([
  /** Criador depositou on-chain, esperando oponente. */
  'waiting',
  /** Os dois depositaram; a partida vai começar. */
  'committed',
  /** Partida em andamento. */
  'playing',
  /** Acabou; aguardando liquidação on-chain. */
  'settled',
])
export type RoomState = z.infer<typeof RoomState>

/**
 * Modalidade da mesa.
 *
 * Fica na SALA, não na partida, porque quem entra precisa saber o que vai
 * jogar antes de depositar. Descobrir a modalidade só depois de o dinheiro
 * estar no contrato seria uma armadilha.
 */
export const GameMode = z.enum(['eightball', 'sinuca'])
export type GameMode = z.infer<typeof GameMode>

export const Room = z.object({
  id: z.string(),
  label: z.string(),
  mode: GameMode,
  creator: z.string(),
  opponent: z.string().nullable(),
  /** Valor da entrada por jogador, em lamports. */
  stake: z.string(),
  state: RoomState,
  /** match_id on-chain, 32 caracteres hex (16 bytes). */
  matchId: z.string(),
  createdAt: z.number(),
  /** Momento em que a sala sai da listagem se ninguém entrar. */
  expiresAt: z.number(),
})
export type Room = z.infer<typeof Room>

export const ErrorCode = z.enum([
  'unauthenticated',
  'bad_request',
  'nonce_invalid',
  'signature_invalid',
  'stake_out_of_range',
  'deposit_not_found',
  'deposit_mismatch',
  'room_not_found',
  'room_not_joinable',
  'already_in_room',
  'not_room_creator',
  'no_reservation',
  'chain_error',
  'rate_limited',
  'internal',

  // Partida
  'match_not_found',
  'not_your_turn',
  'wrong_phase',
  'bad_shot',
  'bad_decision',
  'unknown_player',
  'already_revealed',
  'bad_reveal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

// ---------------------------------------------------------------- cliente →

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('auth'),
    address: z.string(),
    nonce: z.string(),
    message: z.string(),
    signature: z.string(),
  }),
  z.object({ t: z.literal('auth.resume'), token: z.string() }),
  z.object({ t: z.literal('lobby.subscribe') }),

  /** Passo 1 de criar: pede um match_id. Nada acontece on-chain ainda. */
  z.object({
    t: z.literal('lobby.reserve'),
    stake: z.string().regex(/^\d+$/),
    label: z.string().max(24).optional(),
    mode: GameMode.optional(),
  }),
  /** Passo 2: o depósito já foi assinado e enviado; confirme na chain. */
  z.object({ t: z.literal('lobby.confirmCreate'), matchId: z.string() }),

  /** Passo 1 de entrar: reserva a vaga e devolve o match_id para assinar. */
  z.object({ t: z.literal('lobby.requestJoin'), roomId: z.string() }),
  /** Passo 2: depósito do oponente assinado; confirme na chain. */
  z.object({ t: z.literal('lobby.confirmJoin'), roomId: z.string() }),

  /** O cancelamento já foi assinado e enviado; sincronize o lobby. */
  z.object({ t: z.literal('lobby.confirmCancel'), roomId: z.string() }),

  // ------------------------------------------------------------- partida

  /**
   * Compromisso com o nonce da quebra.
   *
   * O jogador sorteia 32 bytes em segredo e manda só o hash. Depois que os
   * dois se comprometeram, ambos revelam — e o seed sai do hash dos dois
   * nonces juntos. Sem isso, quem escolhesse o seed escolheria a quebra: com
   * física determinística, é o mesmo que escolher onde as bolas param.
   */
  z.object({ t: z.literal('match.commit'), commit: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ t: z.literal('match.reveal'), nonce: z.string().regex(/^[0-9a-f]{64}$/) }),

  /**
   * A tacada, já quantizada.
   *
   * São exatamente os inteiros que vão para o replay. Não existe conversão no
   * meio do caminho onde cliente e servidor possam discordar por um bit.
   */
  z.object({
    t: z.literal('match.shoot'),
    angle: z.number().int().min(0).max(65_535),
    power: z.number().int().min(0).max(255),
    spinX: z.number().int().min(-127).max(127),
    spinY: z.number().int().min(-127).max(127),
    /**
     * Bola e caçapa prometidas, quando a regra exige.
     *
     * Vai JUNTO da tacada porque é isso que ela é: uma promessa feita antes de
     * jogar. Numa mensagem separada, o jogador poderia declarar depois de ver
     * o resultado.
     */
    call: z
      .object({ ball: z.number().int().min(0).max(15), pocket: z.number().int().min(0).max(5) })
      .optional(),
  }),

  /**
   * Onde a branca vai, numa bola na mão.
   *
   * Em metros. O servidor quantiza e devolve a posição efetiva — é ela que
   * fica gravada no replay e que a física recebe dos dois lados.
   */
  z.object({
    t: z.literal('match.place'),
    x: z.number().finite(),
    y: z.number().finite(),
  }),

  /** Escolha numa decisão aberta pelas regras. */
  z.object({ t: z.literal('match.decide'), option: z.number().int().min(0).max(255) }),
  z.object({ t: z.literal('match.forfeit') }),

  z.object({ t: z.literal('ping') }),
])
export type ClientMessage = z.infer<typeof ClientMessage>

// ---------------------------------------------------------------- servidor →

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    minStake: z.string(),
    maxStake: z.string(),
    decimals: z.number(),
    symbol: z.string(),
    cluster: z.string(),
    programId: z.string(),
    /** Prazo on-chain da partida, em segundos. */
    matchTimeoutSeconds: z.number(),
    /** Se o servidor pode entregar SOL de teste (só em devnet). */
    faucetAvailable: z.boolean(),
  }),
  z.object({
    t: z.literal('auth.ok'),
    address: z.string(),
    sessionToken: z.string(),
    expiresAt: z.number(),
  }),
  /** Saldo real da carteira on-chain, em lamports. */
  z.object({ t: z.literal('balance'), lamports: z.string() }),

  /** Resposta a `lobby.reserve` / `lobby.requestJoin`: assine e envie. */
  z.object({
    t: z.literal('deposit.required'),
    action: z.enum(['create', 'join']),
    matchId: z.string(),
    stake: z.string(),
    roomId: z.string().nullable(),
    timeoutSeconds: z.number(),
  }),

  z.object({ t: z.literal('lobby.state'), rooms: z.array(Room) }),
  z.object({ t: z.literal('lobby.upsert'), room: Room }),
  z.object({ t: z.literal('lobby.remove'), roomId: z.string() }),
  z.object({ t: z.literal('room.self'), room: Room.nullable() }),
  // ------------------------------------------------------------- partida

  /** A partida existe; mande o compromisso. */
  z.object({
    t: z.literal('match.begin'),
    matchId: z.string(),
    mode: z.enum(['eightball', 'sinuca']),
    /** Índice deste jogador: 0 ou 1. */
    you: z.union([z.literal(0), z.literal(1)]),
    opponent: z.string(),
    revealDeadline: z.number(),
  }),

  /** Os dois se comprometeram; pode revelar. */
  z.object({ t: z.literal('match.reveal.open') }),

  /**
   * Histórico da partida, para quem chega no meio.
   *
   * Vai o replay inteiro — seed, tacos, tacadas e decisões — porque é o mesmo
   * formato que o cliente já sabe ler e que vai para a blockchain. Reenviar só
   * o seed deixaria a mesa remontada na QUEBRA, e o jogador veria uma partida
   * que não é a que está acontecendo.
   */
  z.object({
    t: z.literal('match.history'),
    replay: z.string(),
    turn: z.union([z.literal(0), z.literal(1)]).nullable(),
    deadline: z.number().nullable(),
  }),

  /** A quebra está definida e a partida começou. */
  z.object({
    t: z.literal('match.start'),
    /** Seed da quebra em hex — o cliente arma a mesma mesa. */
    seed: z.string().regex(/^[0-9a-f]{64}$/),
    turn: z.union([z.literal(0), z.literal(1)]),
    deadline: z.number(),
  }),

  /**
   * Uma tacada aconteceu.
   *
   * Vai a tacada e o hash do estado resultante. O cliente simula a MESMA
   * tacada localmente e compara: se divergir, ele sabe na hora, em vez de
   * mostrar uma mesa que não é a real até o fim da partida.
   */
  z.object({
    t: z.literal('match.shot'),
    by: z.union([z.literal(0), z.literal(1)]),
    angle: z.number().int(),
    power: z.number().int(),
    spinX: z.number().int(),
    spinY: z.number().int(),
    stateHash: z.string(),
    /**
     * A tacada foi dada pelo RELÓGIO, não pelo jogador.
     *
     * Muda o que o cliente faz: numa tacada própria ele já aplicou por
     * previsão e só confere o hash, mas a do relógio ninguém previu —
     * inclusive a do próprio jogador que deixou o tempo acabar.
     */
    byClock: z.boolean().optional(),
    turn: z.union([z.literal(0), z.literal(1)]).nullable(),
    deadline: z.number().nullable(),
    status: z.string(),
    score: z.tuple([z.number(), z.number()]).nullable(),
    onTable: z.array(z.number()),
  }),

  /** A tacada da vez exige declarar bola e caçapa. */
  z.object({
    t: z.literal('match.callRequired'),
    who: z.union([z.literal(0), z.literal(1)]),
    ball: z.number().int(),
  }),

  /** Alguém tem bola na mão e precisa colocá-la antes de jogar. */
  z.object({
    t: z.literal('match.ballInHand'),
    who: z.union([z.literal(0), z.literal(1)]),
    region: z.enum(['anywhere', 'kitchen']),
    deadline: z.number(),
  }),

  /** A branca foi colocada. A posição já vem quantizada. */
  z.object({
    t: z.literal('match.placed'),
    by: z.union([z.literal(0), z.literal(1)]),
    x: z.number(),
    y: z.number(),
    /** Posta pelo relógio no ponto de saque, e não escolhida pelo jogador. */
    byClock: z.boolean().optional(),
    deadline: z.number().nullable(),
  }),

  /** Alguém precisa escolher antes da próxima tacada. */
  z.object({
    t: z.literal('match.decision'),
    chooser: z.union([z.literal(0), z.literal(1)]),
    kind: z.string(),
    options: z.array(z.string()),
    deadline: z.number(),
  }),

  /** A escolha foi aplicada. `rerack` avisa que o triângulo foi rearmado. */
  z.object({
    t: z.literal('match.decided'),
    chooser: z.union([z.literal(0), z.literal(1)]),
    option: z.number(),
    rerack: z.boolean(),
    turn: z.union([z.literal(0), z.literal(1)]).nullable(),
    deadline: z.number().nullable(),
  }),

  /** O adversário caiu; contando a tolerância. */
  z.object({ t: z.literal('match.opponentOffline'), until: z.number() }),
  z.object({ t: z.literal('match.opponentOnline') }),

  z.object({
    t: z.literal('match.end'),
    winner: z.union([z.literal(0), z.literal(1)]).nullable(),
    /**
     * Como a partida acabou.
     *
     * Não existe "abandono": quem cai perde os TURNOS, não a partida. E
     * "replay cheio" anula, porque sem espaço para gravar não há como provar
     * o resultado — e um vencedor que o replay não sustenta valeria menos que
     * nenhum.
     */
    reason: z.enum(['regras', 'desistência', 'tempo', 'replay cheio']),
    /** Replay em hex, para o cliente conferir por conta própria. */
    replay: z.string(),
  }),

  /**
   * A liquidação foi para a blockchain.
   *
   * Chega DEPOIS do `match.end` porque a transação leva alguns segundos e o
   * jogador não deve ficar olhando uma tela parada até ela confirmar. Traz a
   * assinatura para ele conferir o pagamento no explorer — é o ponto de o
   * escrow ser on-chain.
   */
  z.object({
    t: z.literal('match.settled'),
    signature: z.string().nullable(),
    /** Motivo, quando não deu para liquidar. */
    reason: z.string().nullable(),
  }),

  z.object({ t: z.literal('error'), code: ErrorCode, message: z.string() }),
  z.object({ t: z.literal('pong') }),
])
export type ServerMessage = z.infer<typeof ServerMessage>

// ---------------------------------------------------------------- utilidades

/**
 * Mensagem de login. O servidor reconstrói esta string a partir do nonce que
 * ele mesmo emitiu e verifica a assinatura contra ela. Mudar o formato quebra
 * o login e exige versionar.
 */
export function buildLoginMessage(host: string, address: string, nonce: string): string {
  return [
    `${host} quer autenticar sua carteira.`,
    '',
    'Assinar esta mensagem é gratuito e NÃO autoriza nenhuma transação.',
    '',
    `Carteira: ${address}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}

export function formatAmount(raw: string | bigint, decimals = DECIMALS): string {
  const value = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function parseAmount(input: string, decimals = DECIMALS): bigint | null {
  const trimmed = input.trim().replace(',', '.')
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null
  const [whole = '0', frac = ''] = trimmed.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole + frac.padEnd(decimals, '0'))
}
