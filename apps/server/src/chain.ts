import { CLUSTER, FALLBACK_MAX_STAKE, FALLBACK_MIN_STAKE, RPC_URL } from '@/config'
import { fetchConfig, fetchMatch, PROGRAM_ID, type OnChainMatch } from '@zinc-pool/chain-client'
import { Connection, PublicKey } from '@solana/web3.js'

/**
 * Limites de aposta.
 *
 * A FONTE É O CONFIG ON-CHAIN. Antes eles viviam também no `.env` do servidor,
 * e os dois podiam divergir: o servidor aceitava a reserva, o jogador assinava
 * na carteira, e só então o programa recusava. Agora o `.env` é apenas o valor
 * de emergência para quando a leitura da chain falha.
 */
export type Limits = { minStake: bigint; maxStake: bigint }

/**
 * Leitura da blockchain.
 *
 * O servidor NUNCA move dinheiro — quem assina o depósito é a carteira do
 * jogador. Tudo que o servidor faz é ler o estado real da chain e decidir se
 * publica a sala. Por isso esta interface só tem leituras.
 *
 * Existir como interface serve a um propósito concreto: os testes usam
 * `FakeChain` e rodam sem rede, sem devnet e sem esperar confirmação de bloco.
 */
export interface Chain {
  readonly cluster: string
  readonly programId: string
  getMatch(matchId: Uint8Array): Promise<OnChainMatch | null>
  getBalance(address: string): Promise<bigint>
  /** Limites vindos do Config on-chain. */
  getLimits(): Promise<Limits>
}

export class SolanaChain implements Chain {
  readonly cluster = CLUSTER
  readonly programId = PROGRAM_ID.toBase58()

  #connection = new Connection(RPC_URL, 'confirmed')

  /** Cache curto: o Config muda raramente, mas não queremos ler a cada mesa. */
  #limits: { valor: Limits; ate: number } | null = null

  async getMatch(matchId: Uint8Array): Promise<OnChainMatch | null> {
    return fetchMatch(this.#connection, matchId)
  }

  async getLimits(): Promise<Limits> {
    const agora = Date.now()
    if (this.#limits && agora < this.#limits.ate) return this.#limits.valor

    try {
      const config = await fetchConfig(this.#connection)
      if (config) {
        const valor = { minStake: config.minStake, maxStake: config.maxStake }
        this.#limits = { valor, ate: agora + 60_000 }
        return valor
      }
    } catch {
      // Cai para o valor de emergência abaixo.
    }

    // Se a chain está inacessível, prefere o último valor conhecido a inventar
    // um limite que o programa não aceitaria.
    if (this.#limits) return this.#limits.valor
    return { minStake: FALLBACK_MIN_STAKE, maxStake: FALLBACK_MAX_STAKE }
  }

  async getBalance(address: string): Promise<bigint> {
    return BigInt(await this.#connection.getBalance(new PublicKey(address), 'confirmed'))
  }
}

/** Chain simulada para testes: o teste diz o que existe on-chain. */
export class FakeChain implements Chain {
  readonly cluster = 'fake'
  readonly programId = PROGRAM_ID.toBase58()

  #matches = new Map<string, OnChainMatch>()
  #balances = new Map<string, bigint>()

  static key(matchId: Uint8Array): string {
    return Buffer.from(matchId).toString('hex')
  }

  async getMatch(matchId: Uint8Array): Promise<OnChainMatch | null> {
    return this.#matches.get(FakeChain.key(matchId)) ?? null
  }

  async getBalance(address: string): Promise<bigint> {
    return this.#balances.get(address) ?? 10_000_000_000n
  }

  limits: Limits = { minStake: FALLBACK_MIN_STAKE, maxStake: FALLBACK_MAX_STAKE }

  async getLimits(): Promise<Limits> {
    return this.limits
  }

  // ---- controles de teste

  setMatch(matchId: Uint8Array, match: OnChainMatch): void {
    this.#matches.set(FakeChain.key(matchId), match)
  }

  removeMatch(matchId: Uint8Array): void {
    this.#matches.delete(FakeChain.key(matchId))
  }

  setBalance(address: string, lamports: bigint): void {
    this.#balances.set(address, lamports)
  }
}
