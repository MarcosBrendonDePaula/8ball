import { existsSync, readFileSync } from 'node:fs'
import { CLUSTER, FAUCET_AMOUNT, FAUCET_COOLDOWN_MS, FAUCET_KEYPAIR_PATH, RPC_URL } from '@/config'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

/**
 * Faucet de desenvolvimento.
 *
 * Os faucets públicos de devnet vivem esgotados (o da Helius dá 1 SOL por dia
 * por projeto), então mandar o usuário para lá costuma não funcionar. Aqui o
 * servidor tenta o airdrop e, se falhar, transfere da própria carteira.
 *
 * SÓ FUNCIONA EM DEVNET. Em mainnet isto estaria distribuindo dinheiro de
 * verdade para qualquer um que chamasse o endpoint — a guarda é dura e não
 * depende de configuração.
 */

const connection = new Connection(RPC_URL, 'confirmed')

/** Último atendimento por endereço, para o cooldown. */
const lastServed = new Map<string, number>()

/** Reserva mínima na carteira do faucet, para ela conseguir pagar as taxas. */
const RESERVE = BigInt(0.01 * LAMPORTS_PER_SOL)

let faucetKeypair: Keypair | null | undefined

function loadKeypair(): Keypair | null {
  if (faucetKeypair !== undefined) return faucetKeypair

  if (!existsSync(FAUCET_KEYPAIR_PATH)) {
    faucetKeypair = null
    return null
  }
  try {
    const secret = JSON.parse(readFileSync(FAUCET_KEYPAIR_PATH, 'utf8')) as number[]
    faucetKeypair = Keypair.fromSecretKey(Uint8Array.from(secret))
  } catch {
    faucetKeypair = null
  }
  return faucetKeypair
}

export const faucetIsAvailable = (): boolean => CLUSTER === 'devnet'

export type FaucetResult =
  | { ok: true; signature: string; lamports: string; source: 'airdrop' | 'wallet' }
  | { ok: false; reason: string; retryAfterMs?: number }

export async function requestFaucet(address: string, now = Date.now()): Promise<FaucetResult> {
  if (!faucetIsAvailable()) {
    return { ok: false, reason: 'O faucet só existe em devnet.' }
  }

  let recipient: PublicKey
  try {
    recipient = new PublicKey(address)
  } catch {
    return { ok: false, reason: 'Endereço inválido.' }
  }

  const last = lastServed.get(address)
  if (last !== undefined && now - last < FAUCET_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'Aguarde antes de pedir de novo.',
      retryAfterMs: FAUCET_COOLDOWN_MS - (now - last),
    }
  }

  // Marca antes de tentar: se marcasse só no sucesso, uma sequência de
  // chamadas simultâneas passaria todas pelo cooldown.
  lastServed.set(address, now)

  // 1) Airdrop da rede. Grátis quando funciona, mas costuma estar esgotado.
  try {
    const signature = await connection.requestAirdrop(recipient, Number(FAUCET_AMOUNT))
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    return { ok: true, signature, lamports: FAUCET_AMOUNT.toString(), source: 'airdrop' }
  } catch {
    // Esperado quando o faucet da rede está no limite. Segue para a carteira.
  }

  // 2) Transferência da carteira do faucet.
  const keypair = loadKeypair()
  if (!keypair) {
    lastServed.delete(address)
    return {
      ok: false,
      reason: 'O airdrop da rede está no limite e não há carteira de faucet configurada.',
    }
  }

  try {
    const available = BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'))
    if (available < FAUCET_AMOUNT + RESERVE) {
      lastServed.delete(address)
      return { ok: false, reason: 'A carteira do faucet está sem saldo.' }
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipient,
        lamports: Number(FAUCET_AMOUNT),
      }),
    )
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
    })
    return { ok: true, signature, lamports: FAUCET_AMOUNT.toString(), source: 'wallet' }
  } catch (err) {
    lastServed.delete(address)
    return { ok: false, reason: `Falha ao enviar: ${String(err)}` }
  }
}
