/**
 * Configuração de rede.
 *
 * A aposta é em SOL nativo. Não há mint para configurar — todo mundo que tem
 * uma carteira Solana já tem o ativo do jogo.
 */

export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'

const DEFAULT_RPC: Record<Cluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
}

const env = import.meta.env

export const CLUSTER: Cluster = (env.VITE_SOLANA_CLUSTER as Cluster) ?? 'mainnet-beta'

/**
 * O RPC público da Solana tem rate limit agressivo e frequentemente rejeita
 * chamadas vindas do browser. Para uso real, configure VITE_RPC_URL com um
 * provedor dedicado (Helius, QuickNode, Triton).
 */
export const RPC_URL: string = env.VITE_RPC_URL || DEFAULT_RPC[CLUSTER]

export const USING_PUBLIC_RPC = !env.VITE_RPC_URL

export function explorerAddressUrl(address: string): string {
  const suffix = CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`
  return `https://solscan.io/account/${address}${suffix}`
}
