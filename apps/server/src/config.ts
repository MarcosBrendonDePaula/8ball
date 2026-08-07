import { fileURLToPath } from 'node:url'
import { DECIMALS, parseAmount } from '@zinc-pool/protocol'

const num = (key: string, fallback: number): number => {
  const raw = process.env[key]
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const amount = (key: string, fallback: string): bigint =>
  parseAmount(process.env[key] ?? fallback, DECIMALS) ?? parseAmount(fallback)!

export const PORT = num('PORT', 8787)

export const CLUSTER = process.env.SOLANA_CLUSTER ?? 'devnet'

const DEFAULT_RPC: Record<string, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
}

export const RPC_URL = process.env.RPC_URL ?? DEFAULT_RPC[CLUSTER] ?? DEFAULT_RPC.devnet!

/**
 * Limites de emergência.
 *
 * Os valores que valem são os do Config on-chain — estes só entram se a
 * leitura da chain falhar. Manter uma cópia autoritativa aqui seria pedir para
 * o servidor aceitar uma mesa que o programa depois recusa.
 * Ajuste os de verdade com: bun scripts/admin.ts set-keys
 */
export const FALLBACK_MIN_STAKE = amount('MIN_STAKE', '0.01')
export const FALLBACK_MAX_STAKE = amount('MAX_STAKE', '5')

/**
 * Prazo on-chain da partida. Depois disso, `claim_timeout` devolve o depósito
 * aos dois e `cancel_match` pode ser acionado por qualquer um. É a rede de
 * segurança para o caso de o servidor ou o referee sumirem.
 */
export const MATCH_TIMEOUT_SECONDS = num('MATCH_TIMEOUT_SECONDS', 3600)

/** Tempo que uma mesa fica listada esperando oponente. */
export const ROOM_TTL_MS = num('ROOM_TTL_MS', 5 * 60 * 1000)

export const NONCE_TTL_MS = num('NONCE_TTL_MS', 5 * 60 * 1000)
export const SESSION_TTL_MS = num('SESSION_TTL_MS', 12 * 60 * 60 * 1000)

export const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL ?? 'SOL'

// ------------------------------------------------------------------ faucet

/** Quanto o faucet entrega por pedido. */
export const FAUCET_AMOUNT = amount('FAUCET_AMOUNT', '0.1')

/** Intervalo mínimo entre dois pedidos da mesma carteira. */
export const FAUCET_COOLDOWN_MS = num('FAUCET_COOLDOWN_MS', 60 * 1000)

/**
 * Carteira que banca o faucet quando o airdrop da rede está no limite.
 * Ausente = só o airdrop é tentado.
 */
export const FAUCET_KEYPAIR_PATH =
  process.env.FAUCET_KEYPAIR ?? fileURLToPath(new URL('../.devnet-faucet.json', import.meta.url))
