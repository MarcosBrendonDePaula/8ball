import { afterAll, expect, test } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { buildLoginMessage, ServerMessage, type ClientMessage } from '@zinc-pool/protocol'

/** Keypair do web3.js não expõe `sign`; a chave privada são os 32 primeiros bytes. */
const sign = (keypair: Keypair, message: string): string =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32)))

/**
 * Teste de ponta a ponta contra o servidor real: sobe o processo, conecta dois
 * clientes WebSocket, autentica os dois com assinatura ed25519 de verdade e
 * roda o fluxo criar → entrar.
 *
 * É o único teste que exercita o protocolo, a autenticação e o lobby juntos —
 * as partes que os testes unitários não conseguem cobrir.
 */

const PORT = 8799
const BASE = `http://localhost:${PORT}`

/** Motor verificado por `bun run determinism`. */
const UA_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0'
/** WebKit — determinismo nunca conferido, e por isso trancado fora das apostas. */
const UA_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

const proc = Bun.spawn(['bun', 'src/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  cwd: import.meta.dir + '/..',
  stdout: 'pipe',
  stderr: 'pipe',
})

afterAll(() => proc.kill())

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100)
  }
  throw new Error('Servidor não subiu.')
}

/** Cliente de teste que guarda as mensagens recebidas e sabe esperar por uma. */
class TestClient {
  #ws: WebSocket
  #inbox: ServerMessage[] = []
  #waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = []

  /**
   * `userAgent` porque o servidor tranca motores não verificados fora das mesas
   * apostadas, e o WebSocket do Bun se anuncia como um cliente que não é
   * navegador nenhum — barrado, corretamente. Um teste de lobby precisa fingir
   * ser o navegador que ele representa.
   */
  constructor(
    readonly keypair: Keypair,
    userAgent = UA_FIREFOX,
  ) {
    // O tipo padrão do `WebSocket` só prevê a lista de subprotocolos; o Bun
    // aceita cabeçalhos, que é o que permite fingir um navegador aqui.
    this.#ws = new WebSocket(`ws://localhost:${PORT}/ws`, {
      headers: { 'user-agent': userAgent },
    } as unknown as string[])
    this.#ws.onmessage = (e) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(e.data)))
      if (!parsed.success) return
      const msg = parsed.data
      // Se alguém já está esperando por esta mensagem, ela é entregue e NÃO
      // vai para o inbox — senão seria consumida duas vezes.
      const idx = this.#waiters.findIndex((w) => w.match(msg))
      if (idx >= 0) this.#waiters.splice(idx, 1)[0]!.resolve(msg)
      else this.#inbox.push(msg)
    }
  }

  get address(): string {
    return this.keypair.publicKey.toBase58()
  }

  async open(): Promise<void> {
    if (this.#ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.#ws.onopen = () => resolve()
      this.#ws.onerror = () => reject(new Error('WS falhou'))
    })
  }

  send(msg: ClientMessage): void {
    this.#ws.send(JSON.stringify(msg))
  }

  /** Espera uma mensagem, olhando também as que já chegaram. */
  async expect<T extends ServerMessage['t']>(t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const seen = this.#inbox.find((m) => m.t === t)
    if (seen) {
      this.#inbox = this.#inbox.filter((m) => m !== seen)
      return seen as Extract<ServerMessage, { t: T }>
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout esperando "${t}"`)), timeoutMs)
      this.#waiters.push({
        match: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as Extract<ServerMessage, { t: T }>)
        },
      })
    })
  }

  async signIn(): Promise<void> {
    const res = await fetch(`${BASE}/api/auth/nonce?address=${this.address}`)
    const { nonce, host } = (await res.json()) as { nonce: string; host: string }
    const message = buildLoginMessage(host, this.address, nonce)
    this.send({ t: 'auth', address: this.address, nonce, message, signature: sign(this.keypair, message) })
    await this.expect('auth.ok')
    // O servidor manda saldo e estado inicial da sala logo após o login.
    // Drenamos aqui para que os `expect` do teste vejam as próximas, não estas.
    await this.expect('balance')
    await this.expect('room.self')
  }

  close(): void {
    this.#ws.close()
  }
}

test('hello anuncia rede e programa on-chain', async () => {
  await waitForServer()
  const client = new TestClient(Keypair.generate())
  await client.open()

  const hello = await client.expect('hello')
  expect(hello.cluster).toBeTruthy()
  expect(hello.programId.length).toBeGreaterThan(30)
  expect(BigInt(hello.minStake)).toBeGreaterThan(0n)
  client.close()
}, 20_000)

test('reservar devolve o match_id a assinar, sem publicar sala', async () => {
  await waitForServer()
  const client = new TestClient(Keypair.generate())
  await client.open()
  await client.signIn()

  client.send({ t: 'lobby.subscribe' })
  const before = await client.expect('lobby.state')

  client.send({ t: 'lobby.reserve', stake: '50000000', label: 'Mesa' })
  const required = await client.expect('deposit.required')

  expect(required.action).toBe('create')
  expect(required.matchId).toHaveLength(32)
  expect(required.stake).toBe('50000000')

  // Reservar nao publica sala: so o deposito confirmado on-chain publica.
  client.send({ t: 'lobby.subscribe' })
  const after = await client.expect('lobby.state')
  expect(after.rooms).toHaveLength(before.rooms.length)

  client.close()
}, 20_000)

test('confirmar um match_id nao reservado e recusado', async () => {
  await waitForServer()
  const client = new TestClient(Keypair.generate())
  await client.open()
  await client.signIn()

  client.send({ t: 'lobby.confirmCreate', matchId: 'ff'.repeat(16) })
  const err = await client.expect('error')
  expect(err.code).toBe('no_reservation')
  client.close()
}, 20_000)

test('assinatura de outra carteira é rejeitada', async () => {
  await waitForServer()

  const victim = Keypair.generate()
  const attacker = Keypair.generate()
  const client = new TestClient(victim)
  await client.open()

  const res = await fetch(`${BASE}/api/auth/nonce?address=${victim.publicKey.toBase58()}`)
  const { nonce, host } = (await res.json()) as { nonce: string; host: string }
  const message = buildLoginMessage(host, victim.publicKey.toBase58(), nonce)

  // Assinada pelo atacante, apresentada como sendo da vítima.
  client.send({
    t: 'auth',
    address: victim.publicKey.toBase58(),
    nonce,
    message,
    signature: sign(attacker, message),
  })

  const err = await client.expect('error')
  expect(err.code).toBe('signature_invalid')
  client.close()
}, 20_000)

test('nonce não pode ser reutilizado', async () => {
  await waitForServer()

  const keypair = Keypair.generate()
  const address = keypair.publicKey.toBase58()
  const res = await fetch(`${BASE}/api/auth/nonce?address=${address}`)
  const { nonce, host } = (await res.json()) as { nonce: string; host: string }
  const message = buildLoginMessage(host, address, nonce)
  const signature = sign(keypair, message)

  const first = new TestClient(keypair)
  await first.open()
  first.send({ t: 'auth', address, nonce, message, signature })
  await first.expect('auth.ok')

  // Mesma assinatura, replicada numa segunda conexão.
  const replay = new TestClient(keypair)
  await replay.open()
  replay.send({ t: 'auth', address, nonce, message, signature })

  const err = await replay.expect('error')
  expect(err.code).toBe('nonce_invalid')

  first.close()
  replay.close()
}, 20_000)

test('operar sala sem autenticar é recusado', async () => {
  await waitForServer()

  const client = new TestClient(Keypair.generate())
  await client.open()
  client.send({ t: 'lobby.reserve', stake: '50000000', label: 'x' })

  const err = await client.expect('error')
  expect(err.code).toBe('unauthenticated')
  client.close()
}, 20_000)

/**
 * A trava do motor.
 *
 * A detecção tem os seus próprios testes; estes provam que ela está LIGADA, no
 * lugar certo — antes de qualquer depósito — e que o jogador recebe um código
 * que dá para tratar, em vez de um erro genérico que parece defeito.
 */
test('WebKit não consegue abrir mesa apostada', async () => {
  await waitForServer()

  const client = new TestClient(Keypair.generate(), UA_SAFARI)
  await client.open()
  await client.signIn()
  client.send({ t: 'lobby.reserve', stake: '50000000', label: 'Mesa' })

  const err = await client.expect('error')
  expect(err.code).toBe('engine_unverified')
  // A recusa vem ANTES de `deposit.required`: barrar depois significaria
  // dinheiro preso na chain esperando o prazo.
  expect(err.message).toContain('sem aposta')
  client.close()
}, 20_000)

test('WebKit também não entra na mesa de outro', async () => {
  await waitForServer()

  const client = new TestClient(Keypair.generate(), UA_SAFARI)
  await client.open()
  await client.signIn()
  client.send({ t: 'lobby.requestJoin', roomId: 'qualquer' })

  // Recusado pelo motor, não por a sala não existir — a ordem importa: a trava
  // vem antes de qualquer coisa que possa levar a um depósito.
  const err = await client.expect('error')
  expect(err.code).toBe('engine_unverified')
  client.close()
}, 20_000)

test('WebKit continua autenticando e vendo o lobby', async () => {
  await waitForServer()

  // O bloqueio é só das APOSTAS. Trancar o login inteiro puniria quem só quer
  // ver o histórico das próprias partidas ou jogar sem dinheiro.
  const client = new TestClient(Keypair.generate(), UA_SAFARI)
  await client.open()
  await client.signIn()
  client.send({ t: 'lobby.subscribe' })

  const estado = await client.expect('lobby.state')
  expect(Array.isArray(estado.rooms)).toBe(true)
  client.close()
}, 20_000)
