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
import { CLUSTER, MATCH_TIMEOUT_SECONDS, PORT, TOKEN_SYMBOL } from '@/config'
import { Lobby, LobbyError } from '@/lobby'
import { ClientMessage, DECIMALS, type ErrorCode, type ServerMessage } from '@zinc-pool/protocol'

const chain = new SolanaChain()
const lobby = new Lobby(chain)

type Session = { address: string | null; subscribed: boolean }

const sockets = new Set<ServerWebSocket<Session>>()

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
