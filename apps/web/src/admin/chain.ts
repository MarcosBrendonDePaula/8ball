import { connection } from '@/wallet/balances'
import {
  PROGRAM_ID,
  fetchConfig,
  fetchVault,
  houseVaultPda,
  treasuryVaultPda,
  type ConfigState,
  type VaultState,
} from '@zinc-pool/chain-client'
import { PublicKey } from '@solana/web3.js'

/**
 * Leitura do painel, direto da blockchain.
 *
 * Não passa pelo servidor de propósito. O servidor tem uma visão em memória do
 * lobby, que pode estar atrasada, incompleta ou simplesmente errada depois de
 * um reinício. Para administrar, o que interessa é o que existe on-chain — e
 * é isso que responde "onde está o dinheiro".
 */

/** Tamanho da conta `Game`, usado para filtrar só partidas. */
const GAME_ACCOUNT_SIZE = 114

export type AdminMatch = {
  pda: string
  matchIdHex: string
  creator: string
  opponent: string | null
  stakeLamports: bigint
  /** Saldo real da PDA: os dois depósitos mais o aluguel. */
  escrowLamports: bigint
  state: 'waiting' | 'committed'
  createdAt: number
  deadline: number
}

export type AdminSnapshot = {
  programId: string
  config: ConfigState | null
  house: (VaultState & { pda: string }) | null
  treasury: (VaultState & { pda: string }) | null
  matches: AdminMatch[]
  fetchedAt: number
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function decodeMatch(pda: PublicKey, data: Uint8Array, lamports: number): AdminMatch {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const matchIdHex = hex(data.slice(offset, offset + 16))
  offset += 16
  const creator = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const opponentKey = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const stakeLamports = view.getBigUint64(offset, true)
  offset += 8
  const state = view.getUint8(offset) === 0 ? 'waiting' : 'committed'
  offset += 1
  const createdAt = Number(view.getBigInt64(offset, true))
  offset += 8
  const deadline = Number(view.getBigInt64(offset, true))

  return {
    pda: pda.toBase58(),
    matchIdHex,
    creator: creator.toBase58(),
    opponent: opponentKey.equals(PublicKey.default) ? null : opponentKey.toBase58(),
    stakeLamports,
    escrowLamports: BigInt(lamports),
    state,
    createdAt,
    deadline,
  }
}

export async function loadSnapshot(): Promise<AdminSnapshot> {
  const [housePda] = houseVaultPda()
  const [treasuryPda] = treasuryVaultPda()

  // Em paralelo: o painel atualiza sozinho, e serializar as leituras deixaria
  // a atualização visivelmente lenta num RPC com latência.
  const [config, house, treasury, contas] = await Promise.all([
    fetchConfig(connection).catch(() => null),
    fetchVault(connection, 'house').catch(() => null),
    fetchVault(connection, 'treasury').catch(() => null),
    connection
      .getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: GAME_ACCOUNT_SIZE }] })
      .catch(() => []),
  ])

  const matches = contas
    .map(({ pubkey, account }) =>
      decodeMatch(pubkey, new Uint8Array(account.data), account.lamports),
    )
    // Mais perto de vencer primeiro: é o que precisa de atenção.
    .sort((a, b) => a.deadline - b.deadline)

  return {
    programId: PROGRAM_ID.toBase58(),
    config,
    house: house ? { ...house, pda: housePda.toBase58() } : null,
    treasury: treasury ? { ...treasury, pda: treasuryPda.toBase58() } : null,
    matches,
    fetchedAt: Date.now(),
  }
}
