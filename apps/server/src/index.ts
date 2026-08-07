import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import type { ServerWebSocket } from 'bun'
import {
  AuthError,
  assertValidAddress,
  issueNonce,
  issueSession,
  resumeSession,
  sweepNonces,
  verifyLogin,
} from '@/auth'
import { SolanaChain } from '@/chain'
import { faucetIsAvailable, requestFaucet } from '@/faucet'
import {
  CLUSTER,
  MATCH_TIMEOUT_SECONDS,
  PORT,
  SWEEPER_ENABLED,
  SWEEPER_KEYPAIR_PATH,
  TOKEN_SYMBOL,
} from '@/config'
import { Lobby, LobbyError } from '@/lobby'
import { MatchRuleError, REVEAL_TIMEOUT_MS } from '@/match'
import { Matches } from '@/matches'
import { startSweeper } from '@/sweeper'
import { settleMatch } from '@/settlement'
import {
  ClientMessage,
  DECIMALS,
  type ErrorCode,
  type Room,
  type ServerMessage,
} from '@zinc-pool/protocol'

const chain = new SolanaChain()
const lobby = new Lobby(chain)
const matches = new Matches()

type Session = { address: string | null; subscribed: boolean }

const sockets = new Set<ServerWebSocket<Session>>()

/**
 * Uma carteira ainda tem alguma conexão aberta?
 *
 * Precisa ser contado, não deduzido de um socket só. O jogador navega do lobby
 * para a mesa — o socket antigo fecha e o novo abre — e pode ter mais de uma
 * aba. Marcar abandono ao fechar QUALQUER socket entregava a partida ao
 * adversário no meio de uma navegação normal.
 */
function aindaConectado(address: string, ignorar?: ServerWebSocket<Session>): boolean {
  for (const ws of sockets) {
    if (ws === ignorar) continue
    if (ws.data.address === address) return true
  }
  return false
}

const send = (ws: ServerWebSocket<Session>, message: ServerMessage): void => {
  ws.send(JSON.stringify(message))
}

const fail = (ws: ServerWebSocket<Session>, code: ErrorCode, message: string): void => {
  send(ws, { t: 'error', code, message })
}

function broadcast(message: ServerMessage, filter?: (s: Session) => boolean): void {
  const payload = JSON.stringify(message)
  for (const ws of sockets) {
    if (filter && !filter(ws.data)) continue
    ws.send(payload)
  }
}

async function pushBalance(ws: ServerWebSocket<Session>): Promise<void> {
  const address = ws.data.address
  if (!address) return
  try {
    const lamports = await chain.getBalance(address)
    send(ws, { t: 'balance', lamports: lamports.toString() })
  } catch {
    // Falha de RPC não deve derrubar a sessão; a UI mostra "—".
  }
}

function pushRoomSelf(addresses: (string | null)[]): void {
  for (const address of addresses) {
    if (!address) continue
    broadcast({ t: 'room.self', room: lobby.roomOf(address) }, (s) => s.address === address)
  }
}

lobby.subscribe((event) => {
  if (event.t === 'upsert') {
    if (event.room.state === 'waiting') {
      broadcast({ t: 'lobby.upsert', room: event.room }, (s) => s.subscribed)
    }
  } else {
    broadcast({ t: 'lobby.remove', roomId: event.roomId }, (s) => s.subscribed)
  }
})

/** Manda a mensagem só para carteiras específicas. */
function toPlayers(enderecos: readonly string[], message: ServerMessage): void {
  const alvo = new Set(enderecos)
  broadcast(message, (s) => s.address !== null && alvo.has(s.address))
}

/** Manda a mensagem só para os dois jogadores de uma partida em andamento. */
function toMatch(matchId: string, message: ServerMessage): void {
  const m = matches.get(matchId)
  if (!m) return
  toPlayers(
    m.players.map((p) => p.address),
    message,
  )
}

matches.subscribe((event) => {
  switch (event.t) {
    case 'begin': {
      // Ainda não existe uma `Match`: os dois precisam se comprometer com o
      // nonce antes. Cada jogador recebe o próprio índice e o do adversário.
      for (const [i, endereco] of event.players.entries()) {
        toPlayers([endereco], {
          t: 'match.begin',
          matchId: event.matchId,
          mode: event.mode,
          you: i === 0 ? 0 : 1,
          opponent: event.players[i === 0 ? 1 : 0]!,
          revealDeadline: Date.now() + REVEAL_TIMEOUT_MS,
        })
      }
      break
    }

    case 'revealOpen':
      toMatch(event.matchId, { t: 'match.reveal.open' })
      break

    case 'start': {
      const m = matches.get(event.matchId)!
      toMatch(event.matchId, {
        t: 'match.start',
        seed: Buffer.from(event.seed).toString('hex'),
        turn: m.turn ?? 0,
        deadline: m.deadline ?? 0,
      })
      break
    }

    case 'shot': {
      const m = matches.get(event.matchId)
      const v = event.view
      toMatch(event.matchId, {
        t: 'match.shot',
        by: v.by,
        angle: v.shot.angle,
        power: v.shot.power,
        spinX: v.shot.spinX,
        spinY: v.shot.spinY,
        stateHash: v.stateHash,
        turn: m?.turn ?? null,
        deadline: m?.deadline ?? null,
        status: v.summary.status,
        score: v.summary.score,
        onTable: v.summary.onTable,
      })
      break
    }

    case 'ballInHand': {
      const m = matches.get(event.matchId)
      const regiao = m?.ballInHand
      if (!m || !regiao) return
      toMatch(event.matchId, {
        t: 'match.ballInHand',
        who: m.summary?.turn ?? 0,
        region: regiao,
        deadline: m.deadline ?? 0,
      })
      break
    }

    case 'placed': {
      const m = matches.get(event.matchId)
      toMatch(event.matchId, {
        t: 'match.placed',
        by: event.by,
        x: event.x,
        y: event.y,
        deadline: m?.deadline ?? null,
      })
      break
    }

    case 'decision': {
      const m = matches.get(event.matchId)
      const p = m?.pending
      if (!m || !p) return
      toMatch(event.matchId, {
        t: 'match.decision',
        chooser: p.chooser,
        kind: p.kind,
        options: [...p.options],
        deadline: m.deadline ?? 0,
      })
      break
    }

    case 'decided': {
      const m = matches.get(event.matchId)
      toMatch(event.matchId, {
        t: 'match.decided',
        chooser: event.chooser,
        option: event.option,
        rerack: event.rerack,
        turn: m?.turn ?? null,
        deadline: m?.deadline ?? null,
      })
      break
    }

    case 'offline':
    case 'online': {
      const m = matches.get(event.matchId)
      if (!m) return
      const caiu = m.players[event.who].address
      // `until` é informativo: não há prazo de abandono, mas a interface mostra
      // que a vez do ausente vai passando sozinha.
      const mensagem: ServerMessage =
        event.t === 'offline'
          ? { t: 'match.opponentOffline', until: Date.now() }
          : { t: 'match.opponentOnline' }
      // Só o ADVERSÁRIO precisa saber; quem caiu não está ouvindo mesmo.
      broadcast(mensagem, (s) => s.address !== null && s.address !== caiu && m.indexOf(s.address) !== null)
      break
    }

    case 'end': {
      // A partida já saiu do registro; os destinatários vêm do evento. Mandar
      // por `toMatch` aqui não acharia ninguém, e um filtro frouxo mandaria o
      // resultado para todos os conectados.
      toPlayers(event.players, {
        t: 'match.end',
        winner: event.result.winner,
        reason: event.result.reason,
        replay: Buffer.from(event.result.replay).toString('hex'),
      })

      // Paga o vencedor e grava o replay. Sem isto, o dinheiro ficaria parado
      // até o prazo e o VARREDOR o devolveria como empate — quem ganhou
      // receberia a entrada de volta em vez do pote.
      void liquidar(event.matchId, event.players, event.result)
      break
    }
  }
})

/**
 * Abre a partida de uma sala fechada, se ainda não existir.
 *
 * Chamado tanto na confirmação do depósito quanto ao o jogador autenticar. O
 * segundo caso não é redundância: uma sala pode ter fechado antes de o
 * servidor reiniciar — ou, como aconteceu de fato, antes de o servidor sequer
 * saber criar partidas. Sem isto, essas mesas ficariam com o dinheiro preso
 * até o prazo, sem nunca virar jogo.
 *
 */
function abrirPartidaSePronta(room: Room | null): void {
  if (!room || room.state !== 'committed' || !room.opponent) return
  if (matches.has(room.matchId)) return

  matches.open(room.matchId, room.mode, [room.creator, room.opponent])
}

/**
 * Põe um jogador recém-conectado de volta na partida.
 *
 * Manda, em ordem: o `match.begin`, o `match.start` com o seed, o histórico do
 * que já foi jogado e a decisão aberta, se houver. Com isso a mesa é remontada
 * exatamente no estado atual, e as tacadas seguintes chegam pelo fluxo normal.
 *
 * O histórico vai no formato do replay, que o cliente já sabe ler e que é o
 * mesmo que vai para a blockchain — não existe um segundo formato de
 * sincronização para divergir do primeiro.
 */
function reenviarPartida(ws: ServerWebSocket<Session>, address: string): void {
  const r = matches.resume(address)
  if (!r) return

  send(ws, {
    t: 'match.begin',
    matchId: r.matchId,
    mode: r.mode,
    you: r.you,
    opponent: r.players[r.you === 0 ? 1 : 0]!,
    revealDeadline: Date.now() + REVEAL_TIMEOUT_MS,
  })

  if (r.match?.recorder && r.match.phase !== 'revealing') {
    send(ws, {
      t: 'match.start',
      seed: Buffer.from(r.match.recorder.seed).toString('hex'),
      turn: r.match.turn ?? 0,
      deadline: r.match.deadline ?? 0,
    })

    // E o que já foi jogado. Sem isto a mesa é remontada na QUEBRA, e o
    // jogador vê uma partida que não é a que está acontecendo.
    if (r.match.recorder.shotCount > 0) {
      send(ws, {
        t: 'match.history',
        replay: Buffer.from(r.match.recorder.toBytes()).toString('hex'),
        turn: r.match.turn,
        deadline: r.match.deadline,
      })
    }

    // Bola na mão aberta: quem reconecta precisa vê-la.
    const regiao = r.match.ballInHand
    if (regiao) {
      send(ws, {
        t: 'match.ballInHand',
        who: r.match.summary?.turn ?? 0,
        region: regiao,
        deadline: r.match.deadline ?? 0,
      })
    }

    // Decisão aberta esperando alguém: quem reconecta precisa vê-la.
    const p = r.match.pending
    if (p) {
      send(ws, {
        t: 'match.decision',
        chooser: p.chooser,
        kind: p.kind,
        options: [...p.options],
        deadline: r.match.deadline ?? 0,
      })
    }
  }
}

async function handle(ws: ServerWebSocket<Session>, msg: ClientMessage, host: string): Promise<void> {
  if (msg.t === 'ping') {
    send(ws, { t: 'pong' })
    return
  }

  if (msg.t === 'auth' || msg.t === 'auth.resume') {
    try {
      const { address, session } =
        msg.t === 'auth'
          ? (() => {
              const addr = verifyLogin(msg, host)
              return { address: addr, session: issueSession(addr) }
            })()
          : (() => {
              const addr = resumeSession(msg.token)
              return { address: addr, session: { token: msg.token, expiresAt: 0 } }
            })()

      ws.data.address = address
      send(ws, { t: 'auth.ok', address, sessionToken: session.token, expiresAt: session.expiresAt })
      // Voltar a autenticar cancela a contagem de abandono: o jogador está de
      // volta e a partida continua de onde parou.
      matches.markOnline(address)
      // E, se a sala dele fechou enquanto o servidor estava fora, é aqui que
      // a partida finalmente nasce.
      abrirPartidaSePronta(lobby.roomOf(address))
      // Reenvia o estado da partida: ir do lobby para a mesa abre um socket
      // novo, e as mensagens que já passaram não voltam sozinhas.
      reenviarPartida(ws, address)
      await pushBalance(ws)
      send(ws, { t: 'room.self', room: lobby.roomOf(address) })
    } catch (err) {
      if (err instanceof AuthError) fail(ws, err.code, err.message)
      else fail(ws, 'internal', 'Falha ao autenticar.')
    }
    return
  }

  if (msg.t === 'lobby.subscribe') {
    ws.data.subscribed = true
    send(ws, { t: 'lobby.state', rooms: lobby.openRooms() })
    return
  }

  const address = ws.data.address
  if (!address) {
    fail(ws, 'unauthenticated', 'Assine o login antes de operar salas.')
    return
  }

  try {
    switch (msg.t) {
      case 'lobby.reserve': {
        const reservation = await lobby.reserve(
          address,
          BigInt(msg.stake),
          msg.label ?? '',
          msg.mode ?? 'eightball',
          Date.now(),
        )
        send(ws, {
          t: 'deposit.required',
          action: 'create',
          matchId: reservation.matchIdHex,
          stake: reservation.stake.toString(),
          roomId: null,
          timeoutSeconds: MATCH_TIMEOUT_SECONDS,
        })
        break
      }

      case 'lobby.confirmCreate': {
        const room = await lobby.confirmCreate(address, msg.matchId, Date.now())
        send(ws, { t: 'room.self', room })
        await pushBalance(ws)
        break
      }

      case 'lobby.requestJoin': {
        const reservation = lobby.requestJoin(address, msg.roomId, Date.now())
        send(ws, {
          t: 'deposit.required',
          action: 'join',
          matchId: reservation.matchIdHex,
          stake: reservation.stake.toString(),
          roomId: msg.roomId,
          timeoutSeconds: MATCH_TIMEOUT_SECONDS,
        })
        break
      }

      case 'lobby.confirmJoin': {
        const room = await lobby.confirmJoin(address, msg.roomId)
        await pushBalance(ws)
        pushRoomSelf([room.creator, room.opponent])

        // Os dois depósitos estão confirmados na chain: a partida pode nascer.
        abrirPartidaSePronta(room)
        break
      }

      case 'match.commit': {
        matches.commit(address, msg.commit)
        break
      }

      case 'match.reveal': {
        matches.reveal(address, Uint8Array.from(Buffer.from(msg.nonce, 'hex')))
        break
      }

      case 'match.shoot': {
        matches.shoot(address, {
          angle: msg.angle,
          power: msg.power,
          spinX: msg.spinX,
          spinY: msg.spinY,
        })
        break
      }

      case 'match.place': {
        matches.place(address, msg.x, msg.y)
        break
      }

      case 'match.decide': {
        matches.decide(address, msg.option)
        break
      }

      case 'match.forfeit': {
        matches.forfeit(address)
        break
      }

      case 'lobby.confirmCancel': {
        const room = lobby.get(msg.roomId)
        await lobby.confirmCancel(address, msg.roomId)
        await pushBalance(ws)
        pushRoomSelf([room?.creator ?? null, room?.opponent ?? null])
        break
      }
    }
  } catch (err) {
    if (err instanceof LobbyError) fail(ws, err.code, err.message)
    else if (err instanceof MatchRuleError) fail(ws, err.code, err.message)
    else {
      console.error('[lobby]', err)
      fail(ws, 'internal', 'Erro interno.')
    }
  }
}

const server = Bun.serve<Session, never>({
  port: PORT,

  fetch(req, srv) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      const ok = srv.upgrade(req, { data: { address: null, subscribed: false } })
      return ok ? undefined : new Response('Upgrade falhou', { status: 400 })
    }

    if (url.pathname === '/api/auth/nonce') {
      const address = url.searchParams.get('address') ?? ''
      try {
        assertValidAddress(address)
      } catch {
        return Response.json({ error: 'Endereço inválido.' }, { status: 400 })
      }
      return Response.json({ nonce: issueNonce(address), host: url.host })
    }

    if (url.pathname === '/api/faucet' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json().catch(() => null)) as { address?: string } | null
        const result = await requestFaucet(body?.address ?? '')
        return Response.json(result, { status: result.ok ? 200 : 400 })
      })()
    }

    if (url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        cluster: CLUSTER,
        programId: chain.programId,
        rooms: lobby.openRooms().length,
      })
    }

    return new Response('Not found', { status: 404 })
  },

  websocket: {
    async open(ws) {
      sockets.add(ws)
      const { minStake, maxStake } = await chain.getLimits()
      send(ws, {
        t: 'hello',
        minStake: minStake.toString(),
        maxStake: maxStake.toString(),
        decimals: DECIMALS,
        symbol: TOKEN_SYMBOL,
        cluster: CLUSTER,
        programId: chain.programId,
        matchTimeoutSeconds: MATCH_TIMEOUT_SECONDS,
        faucetAvailable: faucetIsAvailable(),
      })
    },

    async message(ws, raw) {
      const parsed = ClientMessage.safeParse(safeJson(raw.toString()))
      if (!parsed.success) {
        fail(ws, 'bad_request', 'Mensagem inválida.')
        return
      }
      await handle(ws, parsed.data, new URL(server.url).host)
    },

    close(ws) {
      sockets.delete(ws)
      // Desconectar não mexe em nada on-chain. O depósito continua na PDA e
      // só o dono da chave pode movê-lo.
      //
      // Na partida, porém, sumir tem consequência: começa a contar a
      // tolerância de abandono. Sem isso, quem está perdendo fecharia a aba e
      // prenderia o dinheiro do adversário até o prazo on-chain.
      //
      // Só conta como sumir se NÃO sobrou nenhuma outra conexão da mesma
      // carteira. O `ws` já saiu do conjunto acima, mas passa como ignorado
      // por clareza: quem lê não precisa saber a ordem das duas linhas.
      if (ws.data.address && !aindaConectado(ws.data.address, ws)) {
        matches.markOffline(ws.data.address)
      }
    },
  },
})

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

setInterval(() => {
  void lobby.sweep(Date.now()).catch(() => {})
  sweepNonces()
}, 15_000)

console.log(`ZINC Pool server em http://localhost:${PORT}`)
console.log(`  rede:     ${CLUSTER}`)
console.log(`  programa: ${chain.programId}`)
void chain.getLimits().then(({ minStake, maxStake }) => {
  console.log(`  entrada:  ${minStake} .. ${maxStake} lamports (lidos do Config on-chain)`)
})

// ------------------------------------------------------------- liquidação

/**
 * Chave do referee, carregada uma vez.
 *
 * Precisa ser exatamente a gravada no `Config` on-chain; o contrato recusa
 * qualquer outra. Se faltar, o servidor sobe igual e as partidas caem no
 * reembolso pelo prazo — pior que pagar o vencedor, melhor que travar.
 */
const refereeKeypair = (() => {
  try {
    const secret = JSON.parse(readFileSync(SWEEPER_KEYPAIR_PATH, 'utf8')) as number[]
    return Keypair.fromSecretKey(Uint8Array.from(secret))
  } catch {
    return null
  }
})()

async function liquidar(
  matchId: string,
  players: readonly [string, string],
  result: Parameters<typeof settleMatch>[3],
): Promise<void> {
  if (!refereeKeypair) {
    console.warn(`[settle] sem chave de referee; ${matchId.slice(0, 8)}… irá para reembolso`)
    return
  }

  const r = await settleMatch(
    { connection: chain.connection, referee: refereeKeypair, log: (m) => console.log(m) },
    matchId,
    players,
    result,
  )

  if (!r.ok && r.retriable) {
    // Não insiste em laço: a mesa continua na chain e o varredor a resolve
    // depois do prazo. Insistir aqui gastaria taxa contra um RPC que já se
    // mostrou indisponível.
    console.warn(`[settle] ${matchId.slice(0, 8)}… não liquidou: ${r.reason}`)
  }
}

// --------------------------------------------------------------- varredor

/**
 * Devolve sozinho o dinheiro de mesas vencidas.
 *
 * Antes disto, uma mesa em que os dois depositaram e ninguém liquidou ficava
 * com o dinheiro preso até alguém abrir o painel e clicar "Destravar". Se
 * ninguém abrisse, ficava lá.
 *
 * Roda com a chave do referee, que já vive aqui e já só paga taxa. Não é uma
 * concessão de confiança: o contrato fixa criador e oponente como destinos do
 * reembolso, então quem aciona não tem como desviar nada.
 */
if (SWEEPER_ENABLED) {
  try {
    const secret = JSON.parse(readFileSync(SWEEPER_KEYPAIR_PATH, 'utf8')) as number[]
    const payer = Keypair.fromSecretKey(Uint8Array.from(secret))

    startSweeper({
      connection: chain.connection,
      payer,
      // Não mexe em mesa cuja partida ainda está viva aqui: devolver o
      // dinheiro no meio de uma disputa seria pior do que deixá-lo preso.
      isLive: (matchIdHex) => matches.get(matchIdHex) !== undefined,
      log: (msg) => console.log(msg),
    })
    console.log(`  varredor: ligado (${payer.publicKey.toBase58().slice(0, 8)}…)`)
  } catch {
    // Sem chave, o servidor sobe igual — só não destrava sozinho.
    console.log('  varredor: desligado (chave não encontrada)')
  }
}
