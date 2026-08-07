import { RPC_URL } from '@/config'
import { Connection, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'

export const connection = new Connection(RPC_URL, 'confirmed')

/** Saldo real da carteira on-chain, em SOL. */
export async function getSolBalance(owner: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(owner, 'confirmed')
  return lamports / LAMPORTS_PER_SOL
}
