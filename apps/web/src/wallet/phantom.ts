import { PublicKey, type Transaction } from '@solana/web3.js'

/**
 * Adapter mínimo para a Phantom, falando direto com o provider injetado.
 *
 * Deliberadamente não usamos @solana/wallet-adapter aqui: ele carrega um
 * registro grande de carteiras e assume React. O cliente do jogo é Phaser
 * (vanilla), e nesta fase só precisamos de uma carteira. Quando entrarem
 * Solflare/Backpack, este arquivo vira a implementação de uma interface
 * `Wallet` e as outras entram ao lado.
 */

export type PhantomEvent = 'connect' | 'disconnect' | 'accountChanged'

interface PhantomProvider {
  isPhantom?: boolean
  publicKey: PublicKey | null
  isConnected: boolean
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>
  disconnect(): Promise<void>
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>
  signTransaction(transaction: Transaction): Promise<Transaction>
  on(event: PhantomEvent, handler: (arg: unknown) => void): void
  off(event: PhantomEvent, handler: (arg: unknown) => void): void
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider }
    solana?: PhantomProvider
  }
}

export const PHANTOM_INSTALL_URL = 'https://phantom.app/download'

export function getProvider(): PhantomProvider | null {
  const injected = window.phantom?.solana ?? window.solana
  return injected?.isPhantom ? injected : null
}

export class WalletNotFoundError extends Error {
  constructor() {
    super('Phantom não encontrada neste navegador.')
    this.name = 'WalletNotFoundError'
  }
}

export class UserRejectedError extends Error {
  constructor() {
    super('Conexão recusada na carteira.')
    this.name = 'UserRejectedError'
  }
}

/** Código que a Phantom retorna quando o usuário fecha o popup. */
const PHANTOM_USER_REJECTED = 4001

function isUserRejection(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === PHANTOM_USER_REJECTED
}

export type WalletState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; publicKey: PublicKey }

type Listener = (state: WalletState) => void

export class PhantomWallet {
  #state: WalletState = { status: 'disconnected' }
  #listeners = new Set<Listener>()

  get state(): WalletState {
    return this.#state
  }

  get publicKey(): PublicKey | null {
    return this.#state.status === 'connected' ? this.#state.publicKey : null
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  #set(state: WalletState): void {
    this.#state = state
    for (const l of this.#listeners) l(state)
  }

  /**
   * Reconecta sem popup se o site já foi autorizado antes. Chamado no boot —
   * quem já conectou uma vez não precisa clicar de novo a cada refresh.
   */
  async autoConnect(): Promise<void> {
    const provider = getProvider()
    if (!provider) return
    this.#bindEvents(provider)
    try {
      const { publicKey } = await provider.connect({ onlyIfTrusted: true })
      this.#set({ status: 'connected', publicKey })
    } catch {
      // Site ainda não autorizado. Silencioso por design: é o caminho normal
      // do primeiro acesso, não um erro para mostrar ao usuário.
    }
  }

  async connect(): Promise<PublicKey> {
    const provider = getProvider()
    if (!provider) throw new WalletNotFoundError()
    this.#bindEvents(provider)
    this.#set({ status: 'connecting' })
    try {
      const { publicKey } = await provider.connect()
      this.#set({ status: 'connected', publicKey })
      return publicKey
    } catch (err) {
      this.#set({ status: 'disconnected' })
      throw isUserRejection(err) ? new UserRejectedError() : err
    }
  }

  async disconnect(): Promise<void> {
    const provider = getProvider()
    await provider?.disconnect().catch(() => {})
    this.#set({ status: 'disconnected' })
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const provider = getProvider()
    if (!provider) throw new WalletNotFoundError()
    try {
      const { signature } = await provider.signMessage(message, 'utf8')
      return signature
    } catch (err) {
      throw isUserRejection(err) ? new UserRejectedError() : err
    }
  }

  /**
   * Pede a assinatura da transação — sem enviar.
   *
   * Deliberadamente NÃO usamos `signAndSendTransaction`: aquele método faz a
   * Phantom enviar pela rede que ELA tem selecionada. Se o usuário estivesse
   * em mainnet, uma partida de devnet viraria uma transação com SOL de verdade.
   *
   * Assinando aqui e enviando pela nossa própria conexão, a rede é sempre a
   * que o app configurou, independentemente do que a carteira esteja usando.
   */
  async signTransaction(transaction: Transaction): Promise<Transaction> {
    const provider = getProvider()
    if (!provider) throw new WalletNotFoundError()
    try {
      return await provider.signTransaction(transaction)
    } catch (err) {
      throw isUserRejection(err) ? new UserRejectedError() : err
    }
  }

  #bound = false
  #bindEvents(provider: PhantomProvider): void {
    if (this.#bound) return
    this.#bound = true

    provider.on('connect', (pk) => {
      if (pk instanceof PublicKey) this.#set({ status: 'connected', publicKey: pk })
    })

    provider.on('disconnect', () => this.#set({ status: 'disconnected' }))

    // O usuário trocou de conta dentro da Phantom. Tratamos como uma sessão
    // nova: a identidade mudou, então nada do estado anterior vale.
    provider.on('accountChanged', (pk) => {
      if (pk instanceof PublicKey) this.#set({ status: 'connected', publicKey: pk })
      else this.#set({ status: 'disconnected' })
    })
  }
}
