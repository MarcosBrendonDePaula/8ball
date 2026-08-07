import { connection } from '@/wallet/balances'
import type { PhantomWallet } from '@/wallet/phantom'
import {
  cancelMatchIx,
  createMatchIx,
  joinMatchIx,
  readBalance,
} from '@zinc-pool/chain-client'
import {
  ClientMessage,
  ServerMessage,
  buildLoginMessage,
  type Room,
} from '@zinc-pool/protocol'
import { PublicKey, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'

const SESSION_KEY = 'zincpool.session.token'

export type Connection = 'offline' | 'connecting' | 'online'

export type NetState = {
  connection: Connection
  authenticated: boolean
  address: string | null
  /** Saldo real da carteira on-chain, em lamports. */
  lamports: bigint | null
  rooms: Room[]
  myRoom: Room | null
  limits: {
    minStake: string
    maxStake: string
    symbol: string
    cluster: string
    programId: string
    matchTimeoutSeconds: number
    faucetAvailable: boolean
  } | null
  /** Passo em andamento, para a UI explicar o que está acontecendo. */
  pending: 'creating' | 'joining' | 'cancelling' | 'faucet' | null
  error: string | null
}

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

const unhex = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Cliente do servidor de jogo.
 *
 * A parte importante: criar ou entrar numa mesa é um fluxo de três tempos —
 * o servidor reserva, a CARTEIRA assina e envia a transação, e o servidor
 * confirma lendo a chain. O servidor nunca toca no dinheiro.
 */
export class GameClient {
  #ws: WebSocket | null = null
  #listeners = new Set<(state: NetState) => void>()
  #retry = 0
  #reconnectTimer: number | null = null
  #closedByUs = false

  /**
   * Ouvintes das mensagens de PARTIDA.
   *
   * Separado do `subscribe` do lobby de propósito: o lobby é um estado que a
   * interface redesenha, enquanto a partida é uma sequência de eventos que a
   * cena precisa aplicar em ordem. Espremer os dois no mesmo canal faria a
   * cena redesenhar a mesa a cada saldo que chegasse.
   */
  #matchListeners = new Set<(msg: MatchMessage) => void>()

  /** Resolve quando o servidor responde `deposit.required`. */
  #depositWaiter: ((msg: Extract<ServerMessage, { t: 'deposit.required' }>) => void) | null = null

  state: NetState = {
    connection: 'offline',
    authenticated: false,
    address: null,
    lamports: null,
    rooms: [],
    myRoom: null,
    limits: null,
    pending: null,
    error: null,
  }

  constructor(private readonly wallet: PhantomWallet) {}

  subscribe(listener: (state: NetState) => void): () => void {
    this.#listeners.add(listener)
    listener(this.state)
    return () => this.#listeners.delete(listener)
  }

  /** Ouve as mensagens de partida, na ordem em que chegam. */
  onMatch(listener: (msg: MatchMessage) => void): () => void {
    this.#matchListeners.add(listener)
    return () => this.#matchListeners.delete(listener)
  }

  // -------------------------------------------------------------- partida

  /** Compromisso com o nonce da quebra. Guarda o segredo para revelar depois. */
  commitBreak(): void {
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    this.#nonce = nonce
    void this.#commitHash(nonce).then((commit) => this.#send({ t: 'match.commit', commit }))
  }

  /** Revela o nonce guardado. Só funciona depois de `commitBreak`. */
  revealBreak(): void {
    if (!this.#nonce) return
    this.#send({ t: 'match.reveal', nonce: toHex(this.#nonce) })
  }

  shoot(shot: { angle: number; power: number; spinX: number; spinY: number }): void {
    this.#send({ t: 'match.shoot', ...shot })
  }

  decide(option: number): void {
    this.#send({ t: 'match.decide', option })
  }

  forfeit(): void {
    this.#send({ t: 'match.forfeit' })
  }

  #nonce: Uint8Array | null = null

  async #commitHash(nonce: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', nonce as BufferSource)
    return toHex(new Uint8Array(digest))
  }

  #patch(patch: Partial<NetState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.#listeners) l(this.state)
  }

  connect(): void {
    if (this.#ws && this.#ws.readyState <= WebSocket.OPEN) return
    this.#closedByUs = false
    this.#patch({ connection: 'connecting' })

    const ws = new WebSocket(WS_URL)
    this.#ws = ws

    ws.onopen = () => {
      this.#retry = 0
      this.#patch({ connection: 'online', error: null })
      this.#send({ t: 'lobby.subscribe' })
      const token = localStorage.getItem(SESSION_KEY)
      if (token) this.#send({ t: 'auth.resume', token })
    }

    ws.onmessage = (event) => {
      const parsed = ServerMessage.safeParse(safeJson(event.data))
      if (parsed.success) this.#onMessage(parsed.data)
    }

    ws.onclose = () => {
      this.#ws = null
      this.#patch({ connection: 'offline', authenticated: false })
      if (!this.#closedByUs) this.#scheduleReconnect()
    }

    ws.onerror = () => {}
  }

  disconnect(): void {
    this.#closedByUs = true
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer)
    this.#ws?.close()
    localStorage.removeItem(SESSION_KEY)
    this.#patch({
      connection: 'offline',
      authenticated: false,
      address: null,
      lamports: null,
      myRoom: null,
      pending: null,
    })
  }

  #scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.#retry++, 15_000)
    this.#reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  #onMessage(msg: ServerMessage): void {
    // Mensagens de partida seguem direto para quem estiver jogando, sem passar
    // pelo estado do lobby: a cena precisa da ORDEM, não de um instantâneo.
    if (MATCH_MESSAGES.has(msg.t)) {
      for (const l of this.#matchListeners) l(msg as MatchMessage)
      return
    }

    switch (msg.t) {
      case 'hello':
        this.#patch({
          limits: {
            minStake: msg.minStake,
            maxStake: msg.maxStake,
            symbol: msg.symbol,
            cluster: msg.cluster,
            programId: msg.programId,
            matchTimeoutSeconds: msg.matchTimeoutSeconds,
            faucetAvailable: msg.faucetAvailable,
          },
        })
        break

      case 'auth.ok':
        if (msg.sessionToken) localStorage.setItem(SESSION_KEY, msg.sessionToken)
        this.#patch({ authenticated: true, address: msg.address, error: null })
        break

      case 'balance':
        this.#patch({ lamports: BigInt(msg.lamports) })
        break

      case 'deposit.required':
        this.#depositWaiter?.(msg)
        this.#depositWaiter = null
        break

      case 'lobby.state':
        this.#patch({ rooms: msg.rooms })
        break

      case 'lobby.upsert': {
        const rooms = this.state.rooms.filter((r) => r.id !== msg.room.id)
        rooms.push(msg.room)
        rooms.sort((a, b) => a.createdAt - b.createdAt)
        this.#patch({ rooms })
        break
      }

      case 'lobby.remove':
        this.#patch({ rooms: this.state.rooms.filter((r) => r.id !== msg.roomId) })
        break

      case 'room.self':
        this.#patch({ myRoom: msg.room, pending: null })
        break

      case 'error':
        if (msg.code === 'nonce_invalid' && !this.state.authenticated) {
          localStorage.removeItem(SESSION_KEY)
          break
        }
        this.#patch({ error: msg.message, pending: null })
        break

      case 'pong':
        break
    }
  }

  #send(msg: ClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg))
  }

  /** Envia e espera o `deposit.required` correspondente. */
  #requestDeposit(msg: ClientMessage): Promise<Extract<ServerMessage, { t: 'deposit.required' }>> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#depositWaiter = null
        reject(new Error('O servidor não respondeu a tempo.'))
      }, 10_000)

      this.#depositWaiter = (m) => {
        clearTimeout(timer)
        resolve(m)
      }
      this.#send(msg)
    })
  }

  async signIn(): Promise<void> {
    const publicKey = this.wallet.publicKey
    if (!publicKey) throw new Error('Conecte a carteira primeiro.')
    const address = publicKey.toBase58()

    const res = await fetch(`/api/auth/nonce?address=${encodeURIComponent(address)}`)
    if (!res.ok) throw new Error('Servidor recusou o pedido de login.')
    const { nonce, host } = (await res.json()) as { nonce: string; host: string }

    const message = buildLoginMessage(host, address, nonce)
    const signature = await this.wallet.signMessage(new TextEncoder().encode(message))

    this.#send({ t: 'auth', address, nonce, message, signature: bs58.encode(signature) })
  }

/**
   * Monta, faz a carteira assinar e envia PELA NOSSA conexão.
   *
   * Enviar por conta própria é o que garante a rede correta: o
   * `signAndSendTransaction` da Phantom usaria a rede selecionada nela, e o
   * usuário em mainnet acabaria gastando SOL de verdade numa partida de devnet.
   */
  async #signAndSend(
    instruction: Parameters<Transaction['add']>[0],
    payer: PublicKey,
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

    const tx = new Transaction().add(instruction)
    tx.feePayer = payer
    tx.recentBlockhash = blockhash

    const signed = await this.wallet.signTransaction(tx)
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    return signature
  }

  /**
   * Cria uma mesa: reserva → Phantom assina o depósito → servidor confirma.
   *
   * A confirmação só é pedida depois que a transação está confirmada na chain,
   * senão o servidor leria uma conta que ainda não existe.
   */
  async createRoom(stake: string, label: string): Promise<void> {
    const publicKey = this.wallet.publicKey
    if (!publicKey) throw new Error('Conecte a carteira primeiro.')

    this.#patch({ pending: 'creating', error: null })
    try {
      const required = await this.#requestDeposit({ t: 'lobby.reserve', stake, label })

      await this.#signAndSend(
        createMatchIx({
          creator: publicKey,
          matchId: unhex(required.matchId),
          stake: BigInt(required.stake),
          timeoutSeconds: BigInt(required.timeoutSeconds),
        }),
        publicKey,
      )

      this.#send({ t: 'lobby.confirmCreate', matchId: required.matchId })
    } catch (err) {
      this.#patch({ pending: null })
      throw err
    }
  }

  async joinRoom(roomId: string): Promise<void> {
    const publicKey = this.wallet.publicKey
    if (!publicKey) throw new Error('Conecte a carteira primeiro.')

    this.#patch({ pending: 'joining', error: null })
    try {
      const required = await this.#requestDeposit({ t: 'lobby.requestJoin', roomId })

      await this.#signAndSend(
        joinMatchIx({ opponent: publicKey, matchId: unhex(required.matchId) }),
        publicKey,
      )

      this.#send({ t: 'lobby.confirmJoin', roomId })
    } catch (err) {
      this.#patch({ pending: null })
      throw err
    }
  }

  async cancelRoom(roomId: string): Promise<void> {
    const publicKey = this.wallet.publicKey
    const room = this.state.myRoom
    if (!publicKey || !room) throw new Error('Nenhuma mesa para cancelar.')

    this.#patch({ pending: 'cancelling', error: null })
    try {
      await this.#signAndSend(
        cancelMatchIx({
          signer: publicKey,
          creator: new PublicKey(room.creator),
          matchId: unhex(room.matchId),
        }),
        publicKey,
      )

      this.#send({ t: 'lobby.confirmCancel', roomId })
    } catch (err) {
      this.#patch({ pending: null })
      throw err
    }
  }

  /**
   * Pede SOL de teste ao servidor.
   *
   * O faucet vive no servidor porque os públicos limitam por IP e o cliente
   * não teria como tratar isso — nem como cair para uma carteira de reserva
   * quando o airdrop da rede está esgotado.
   */
  async requestFaucet(): Promise<string> {
    const address = this.state.address
    if (!address) throw new Error('Conecte a carteira primeiro.')

    this.#patch({ pending: 'faucet', error: null })
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const result = (await res.json()) as
        | { ok: true; signature: string; lamports: string }
        | { ok: false; reason: string; retryAfterMs?: number }

      if (!result.ok) {
        throw new Error(
          result.retryAfterMs
            ? `${result.reason} (${Math.ceil(result.retryAfterMs / 1000)}s)`
            : result.reason,
        )
      }

      // O servidor já confirmou, mas o RPC leva um instante para refletir o
      // saldo novo — ler uma vez só mostraria o valor antigo e pareceria que
      // o faucet falhou.
      await this.refreshBalance({ waitForChange: true })
      return result.signature
    } finally {
      this.#patch({ pending: null })
    }
  }

  /**
   * Relê o saldo on-chain.
   *
   * Com `waitForChange`, espera o valor mudar de fato — necessário depois de
   * uma transação, porque o nó que responde a leitura pode estar atrás do que
   * confirmou a escrita.
   */
  async refreshBalance(options: { waitForChange?: boolean } = {}): Promise<bigint | null> {
    const address = this.state.address
    if (!address) return null
    try {
      const lamports = await readBalance(connection, new PublicKey(address), {
        ...(options.waitForChange && this.state.lamports !== null
          ? { from: this.state.lamports }
          : {}),
      })
      this.#patch({ lamports })
      return lamports
    } catch {
      // Falha de RPC: mantém o valor anterior em vez de zerar a tela.
      return null
    }
  }

  clearError(): void {
    if (this.state.error) this.#patch({ error: null })
  }
}

function safeJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}

/** Mensagens que pertencem à partida, e não ao lobby. */
export type MatchMessage = Extract<
  ServerMessage,
  {
    t:
      | 'match.begin'
      | 'match.reveal.open'
      | 'match.start'
      | 'match.shot'
      | 'match.decision'
      | 'match.decided'
      | 'match.opponentOffline'
      | 'match.opponentOnline'
      | 'match.end'
  }
>

const MATCH_MESSAGES = new Set<ServerMessage['t']>([
  'match.begin',
  'match.reveal.open',
  'match.start',
  'match.shot',
  'match.decision',
  'match.decided',
  'match.opponentOffline',
  'match.opponentOnline',
  'match.end',
])

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
