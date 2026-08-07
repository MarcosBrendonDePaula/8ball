import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js'

/**
 * Cliente do programa `pool_escrow`.
 *
 * Monta instruções e decodifica contas. Não assina nada — quem assina é a
 * carteira do jogador (create/join) ou a chave do referee (settle). Ver
 * docs/TDD.md §6.4 sobre por que o servidor não pode depositar pelo jogador.
 *
 * Este pacote roda no NAVEGADOR e no servidor, então nada de `node:crypto` ou
 * `Buffer`: só `Uint8Array` e `@noble/hashes`, que funcionam nos dois.
 */

export const PROGRAM_ID = new PublicKey('4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht')

export const BPS_DENOMINATOR = 10_000n

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('Hex de comprimento ímpar.')
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('Hex inválido.')
    out[i] = byte
  }
  return out
}

/**
 * Discriminador do Anchor: 8 primeiros bytes de sha256("global:<instrução>").
 * É como o programa sabe qual instrução executar.
 */
function ixDiscriminator(name: string): Uint8Array {
  return sha256(utf8(`global:${name}`)).subarray(0, 8)
}

function accountDiscriminator(name: string): Uint8Array {
  return sha256(utf8(`account:${name}`)).subarray(0, 8)
}

// ------------------------------------------------------------------- PDAs

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('config')], PROGRAM_ID)
}

/**
 * Cofres do programa. São PDAs — não existe chave privada.
 *
 * `house` acumula os 5% de operação; `treasury` acumula os 5% destinados à
 * queima. O saldo só se move pelas regras do programa.
 */
export function houseVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('house')], PROGRAM_ID)
}

export function treasuryVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('treasury')], PROGRAM_ID)
}

/** Incinerador da Solana: lamports enviados para cá são destruídos. */
export const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111')

export function matchPda(matchId: Uint8Array): [PublicKey, number] {
  if (matchId.length !== 16) throw new Error('match_id deve ter 16 bytes.')
  return PublicKey.findProgramAddressSync([utf8('match'), matchId], PROGRAM_ID)
}

/** Converte um UUID em match_id de 16 bytes. */
export function matchIdFromUuid(uuid: string): Uint8Array {
  return hexToBytes(uuid.replace(/-/g, ''))
}

// ----------------------------------------------------------- serialização

const u64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

const i64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

// -------------------------------------------------------------- instruções

export function initializeIx(params: {
  authority: PublicKey
  referee: PublicKey
  minStake: bigint
  maxStake: bigint
}): TransactionInstruction {
  const [config] = configPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat(
        ixDiscriminator('initialize'),
        params.referee.toBytes(),
        u64(params.minStake),
        u64(params.maxStake),
      ),
    ),
  })
}

export function createMatchIx(params: {
  creator: PublicKey
  matchId: Uint8Array
  stake: bigint
  timeoutSeconds: bigint
}): TransactionInstruction {
  const [config] = configPda()
  const [game] = matchPda(params.matchId)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat(
        ixDiscriminator('create_match'),
        params.matchId,
        u64(params.stake),
        i64(params.timeoutSeconds),
      ),
    ),
  })
}

export function joinMatchIx(params: {
  opponent: PublicKey
  matchId: Uint8Array
}): TransactionInstruction {
  const [config] = configPda()
  const [game] = matchPda(params.matchId)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.opponent, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixDiscriminator('join_match')),
  })
}

/**
 * Cancela uma mesa sem oponente.
 *
 * Antes do prazo, `signer` precisa ser o criador. Depois do prazo, qualquer um
 * pode acionar — o depósito volta para o criador de qualquer forma.
 */
export function cancelMatchIx(params: {
  signer: PublicKey
  creator: PublicKey
  matchId: Uint8Array
}): TransactionInstruction {
  const [game] = matchPda(params.matchId)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.signer, isSigner: true, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: params.creator, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(ixDiscriminator('cancel_match')),
  })
}

/**
 * Procedência de uma versão da física.
 *
 * Uma conta por versão: quem tem um replay lê a versão dele e busca aqui a
 * especificação correspondente.
 */
export function provenancePda(engineVersion: number): [PublicKey, number] {
  const versao = new Uint8Array(2)
  new DataView(versao.buffer).setUint16(0, engineVersion, true)
  return PublicKey.findProgramAddressSync([utf8('provenance'), versao], PROGRAM_ID)
}

export function publishProvenanceIx(params: {
  authority: PublicKey
  engineVersion: number
  /** Impressão digital em ASCII, 8 caracteres. */
  physicsDigest: string
  /** SHA-256 do documento de especificação. */
  specHash: Uint8Array
  /** Onde o documento está arquivado permanentemente. */
  specUri: string
}): TransactionInstruction {
  if (params.physicsDigest.length !== 8) {
    throw new Error('A impressão digital deve ter 8 caracteres.')
  }
  if (params.specHash.length !== 32) throw new Error('spec_hash deve ter 32 bytes.')

  const [config] = configPda()
  const [provenance] = provenancePda(params.engineVersion)

  const versao = new Uint8Array(2)
  new DataView(versao.buffer).setUint16(0, params.engineVersion, true)

  const uri = utf8(params.specUri)
  const tamanhoUri = new Uint8Array(4)
  new DataView(tamanhoUri.buffer).setUint32(0, uri.length, true)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: provenance, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat(
        ixDiscriminator('publish_provenance'),
        versao,
        utf8(params.physicsDigest),
        params.specHash,
        tamanhoUri,
        uri,
      ),
    ),
  })
}

export type ProvenanceRecord = {
  engineVersion: number
  physicsDigest: string
  specHash: Uint8Array
  specUri: string
  publishedAt: number
}

export async function fetchProvenance(
  connection: Connection,
  engineVersion: number,
): Promise<ProvenanceRecord | null> {
  const [pda] = provenancePda(engineVersion)
  const info = await connection.getAccountInfo(pda, 'confirmed')
  if (!info) return null

  const data = new Uint8Array(info.data)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const versao = view.getUint16(offset, true)
  offset += 2
  const digest = new TextDecoder().decode(data.subarray(offset, offset + 8))
  offset += 8
  const specHash = data.slice(offset, offset + 32)
  offset += 32
  const tamanho = view.getUint32(offset, true)
  offset += 4
  const specUri = new TextDecoder().decode(data.subarray(offset, offset + tamanho))
  offset += tamanho
  const publishedAt = Number(view.getBigInt64(offset, true))

  return { engineVersion: versao, physicsDigest: digest, specHash, specUri, publishedAt }
}

/** Registro permanente da partida. É onde o replay fica gravado. */
export function recordPda(matchId: Uint8Array): [PublicKey, number] {
  if (matchId.length !== 16) throw new Error('match_id deve ter 16 bytes.')
  return PublicKey.findProgramAddressSync([utf8('replay'), matchId], PROGRAM_ID)
}

export function settleMatchIx(params: {
  referee: PublicKey
  matchId: Uint8Array
  creator: PublicKey
  winner: PublicKey
  resultHash: Uint8Array
  /** Bytes do replay. Ficam gravados on-chain, para sempre. */
  replay: Uint8Array
}): TransactionInstruction {
  if (params.resultHash.length !== 32) throw new Error('result_hash deve ter 32 bytes.')
  const [config] = configPda()
  const [game] = matchPda(params.matchId)
  const [treasury] = treasuryVaultPda()
  const [house] = houseVaultPda()
  const [record] = recordPda(params.matchId)

  // Prefixo de comprimento do Vec<u8> no Borsh.
  const tamanho = new Uint8Array(4)
  new DataView(tamanho.buffer).setUint32(0, params.replay.length, true)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.referee, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: params.creator, isSigner: false, isWritable: true },
      { pubkey: params.winner, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: house, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat(
        ixDiscriminator('settle_match'),
        params.winner.toBytes(),
        params.resultHash,
        tamanho,
        params.replay,
      ),
    ),
  })
}

export type MatchRecord = {
  matchId: Uint8Array
  winner: PublicKey
  loser: PublicKey
  pot: bigint
  settledAt: number
  resultHash: Uint8Array
  /** Bytes do replay, prontos para `decodeReplay`. */
  replay: Uint8Array
}

/**
 * Lê o registro permanente de uma partida.
 *
 * É a porta da auditoria: qualquer pessoa chama isto, decodifica o replay e
 * confere o resultado sem depender de nenhum serviço nosso.
 */
/**
 * Onde cada campo do `MatchRecord` começa.
 *
 * Usado nos filtros do RPC: consultar por vencedor ou perdedor exige o
 * deslocamento exato do campo dentro da conta.
 */
const RECORD_OFFSET = {
  matchId: 8,
  winner: 24,
  loser: 56,
} as const

/** Decodifica os bytes de um `MatchRecord` já lido. */
export function decodeMatchRecord(data: Uint8Array): MatchRecord {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const id = data.slice(offset, offset + 16)
  offset += 16
  const winner = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const loser = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const pot = view.getBigUint64(offset, true)
  offset += 8
  const settledAt = Number(view.getBigInt64(offset, true))
  offset += 8
  const resultHash = data.slice(offset, offset + 32)
  offset += 32
  const tamanho = view.getUint32(offset, true)
  offset += 4
  const replay = data.slice(offset, offset + tamanho)

  return { matchId: id, winner, loser, pot, settledAt, resultHash, replay }
}

/**
 * Histórico de partidas de um jogador, lido DIRETO da blockchain.
 *
 * Sem banco de dados de propósito. O `MatchRecord` de cada partida liquidada é
 * permanente e público, então o histórico não depende de nós existirmos — e o
 * próprio jogador pode refazer esta consulta com qualquer RPC, sem confiar na
 * nossa versão dos fatos.
 *
 * São duas consultas porque a conta guarda vencedor e perdedor em campos
 * diferentes, e o RPC filtra por posição de byte.
 */
export async function fetchPlayerHistory(
  connection: Connection,
  player: PublicKey,
): Promise<(MatchRecord & { pda: PublicKey; won: boolean })[]> {
  // O discriminador é obrigatório no filtro. Sem ele, a consulta por vencedor
  // no offset 24 também casa com contas `Game`, onde o CRIADOR fica no mesmo
  // deslocamento — e decodificá-las como registro estoura o buffer.
  const daClasse = {
    memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator('MatchRecord')) },
  }

  const porCampo = async (offset: number) =>
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [daClasse, { memcmp: { offset, bytes: player.toBase58() } }],
    })

  const [vitorias, derrotas] = await Promise.all([
    porCampo(RECORD_OFFSET.winner).catch(() => []),
    porCampo(RECORD_OFFSET.loser).catch(() => []),
  ])

  return [...vitorias, ...derrotas]
    .map(({ pubkey, account }) => {
      const registro = decodeMatchRecord(new Uint8Array(account.data))
      return { ...registro, pda: pubkey, won: registro.winner.equals(player) }
    })
    // Mais recente primeiro: é o que o jogador quer ver.
    .sort((a, b) => b.settledAt - a.settledAt)
}

export async function fetchMatchRecord(
  connection: Connection,
  matchId: Uint8Array,
): Promise<MatchRecord | null> {
  const [pda] = recordPda(matchId)
  const info = await connection.getAccountInfo(pda, 'confirmed')
  if (!info) return null

  const data = new Uint8Array(info.data)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const id = data.slice(offset, offset + 16)
  offset += 16
  const winner = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const loser = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const pot = view.getBigUint64(offset, true)
  offset += 8
  const settledAt = Number(view.getBigInt64(offset, true))
  offset += 8
  const resultHash = data.slice(offset, offset + 32)
  offset += 32
  const tamanho = view.getUint32(offset, true)
  offset += 4
  const replay = data.slice(offset, offset + tamanho)

  return { matchId: id, winner, loser, pot, settledAt, resultHash, replay }
}

export function claimTimeoutIx(params: {
  caller: PublicKey
  matchId: Uint8Array
  creator: PublicKey
  opponent: PublicKey
}): TransactionInstruction {
  const [game] = matchPda(params.matchId)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.caller, isSigner: true, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: params.creator, isSigner: false, isWritable: true },
      { pubkey: params.opponent, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(ixDiscriminator('claim_timeout')),
  })
}

export function migrateConfigIx(authority: PublicKey): TransactionInstruction {
  const [config] = configPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixDiscriminator('migrate_config')),
  })
}

const u16le = (value: number): Uint8Array => {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, true)
  return out
}

/** Piso do que o vencedor recebe. Espelha `MIN_WINNER_BPS` no programa. */
export const MIN_WINNER_BPS = 8_500

export function setSplitsIx(params: {
  authority: PublicKey
  winnerBps: number
  houseBps: number
  protocolBps: number
}): TransactionInstruction {
  const [config] = configPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concat(
        ixDiscriminator('set_splits'),
        u16le(params.winnerBps),
        u16le(params.houseBps),
        u16le(params.protocolBps),
      ),
    ),
  })
}

export function initVaultsIx(authority: PublicKey): TransactionInstruction {
  const [config] = configPda()
  const [house] = houseVaultPda()
  const [treasury] = treasuryVaultPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: house, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixDiscriminator('init_vaults')),
  })
}

export function withdrawHouseIx(params: {
  authority: PublicKey
  destination: PublicKey
  amount: bigint
}): TransactionInstruction {
  const [config] = configPda()
  const [house] = houseVaultPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: house, isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concat(ixDiscriminator('withdraw_house'), u64(params.amount))),
  })
}

/** Queima do tesouro. Qualquer um pode acionar — não beneficia quem chama. */
export function burnTreasuryIx(params: { caller: PublicKey; amount: bigint }): TransactionInstruction {
  const [treasury] = treasuryVaultPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.caller, isSigner: true, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: INCINERATOR, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concat(ixDiscriminator('burn_treasury'), u64(params.amount))),
  })
}

// --------------------------------------------------------------- leitura

export type VaultState = {
  /** Saldo atual, em lamports. */
  lamports: bigint
  /** Acumulado histórico recebido. */
  totalIn: bigint
  /** Acumulado retirado (ou queimado, no tesouro). */
  totalOut: bigint
  matchesSettled: bigint
}

export async function fetchVault(
  connection: Connection,
  kind: 'house' | 'treasury',
): Promise<VaultState | null> {
  const [pda] = kind === 'house' ? houseVaultPda() : treasuryVaultPda()
  const info = await connection.getAccountInfo(pda, 'confirmed')
  if (!info) return null

  const data = new Uint8Array(info.data)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8 + 1 // discriminador + kind

  const totalIn = view.getBigUint64(offset, true)
  offset += 8
  const totalOut = view.getBigUint64(offset, true)
  offset += 8
  const matchesSettled = view.getBigUint64(offset, true)

  return { lamports: BigInt(info.lamports), totalIn, totalOut, matchesSettled }
}

export type OnChainMatch = {
  matchId: Uint8Array
  creator: PublicKey
  opponent: PublicKey | null
  stake: bigint
  state: 'waiting' | 'committed'
  createdAt: number
  deadline: number
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * Lê a conta da partida direto da chain.
 *
 * É assim que o servidor confirma um depósito — nunca acreditando no cliente
 * que diz "depositei", mas olhando o estado real.
 */
export async function fetchMatch(
  connection: Connection,
  matchId: Uint8Array,
): Promise<OnChainMatch | null> {
  const [game] = matchPda(matchId)
  const info = await connection.getAccountInfo(game, 'confirmed')
  if (!info) return null

  const data = new Uint8Array(info.data)
  if (!equalBytes(data.subarray(0, 8), accountDiscriminator('Game'))) {
    throw new Error('A conta existe mas não é uma partida deste programa.')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const id = data.slice(offset, offset + 16)
  offset += 16
  const creator = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const opponentKey = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const stake = view.getBigUint64(offset, true)
  offset += 8
  const state = view.getUint8(offset)
  offset += 1
  const createdAt = Number(view.getBigInt64(offset, true))
  offset += 8
  const deadline = Number(view.getBigInt64(offset, true))

  return {
    matchId: id,
    creator,
    opponent: opponentKey.equals(PublicKey.default) ? null : opponentKey,
    stake,
    state: state === 0 ? 'waiting' : 'committed',
    createdAt,
    deadline,
  }
}

/**
 * Tamanho exato de uma conta `Game`.
 *
 * Serve de filtro no `getProgramAccounts`: sem ele o RPC devolveria também
 * config, cofres, registros de replay e procedências, e a decodificação
 * quebraria na primeira conta de outro tipo.
 */
export const GAME_ACCOUNT_SIZE = 114

/** Decodifica uma conta `Game` já lida. */
export function decodeGame(data: Uint8Array): OnChainMatch {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const matchId = data.slice(offset, offset + 16)
  offset += 16
  const creator = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const opponentKey = new PublicKey(data.subarray(offset, offset + 32))
  offset += 32
  const stake = view.getBigUint64(offset, true)
  offset += 8
  const state = view.getUint8(offset)
  offset += 1
  const createdAt = Number(view.getBigInt64(offset, true))
  offset += 8
  const deadline = Number(view.getBigInt64(offset, true))

  return {
    matchId,
    creator,
    opponent: opponentKey.equals(PublicKey.default) ? null : opponentKey,
    stake,
    state: state === 0 ? 'waiting' : 'committed',
    createdAt,
    deadline,
  }
}

/**
 * Todas as mesas abertas no programa.
 *
 * Ordenadas por prazo, mais perto de vencer primeiro — é o que precisa de
 * atenção, tanto no painel quanto no varredor automático.
 */
export async function fetchAllMatches(
  connection: Connection,
): Promise<(OnChainMatch & { pda: PublicKey; lamports: number })[]> {
  const contas = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: GAME_ACCOUNT_SIZE }],
  })

  return contas
    .map(({ pubkey, account }) => ({
      ...decodeGame(new Uint8Array(account.data)),
      pda: pubkey,
      lamports: account.lamports,
    }))
    .sort((a, b) => a.deadline - b.deadline)
}

/**
 * Lê o saldo esperando a propagação do RPC.
 *
 * Uma transação confirmada não aparece no `getBalance` imediatamente — o nó
 * que responde a leitura pode estar alguns slots atrás do que confirmou a
 * escrita. Ler uma vez logo após confirmar devolve o valor ANTIGO, e a conta
 * parece não ter mudado.
 *
 * Passe `from` (o saldo antes) para esperar até ele mudar de fato. Sem `from`,
 * é uma leitura simples.
 */
export async function readBalance(
  connection: Connection,
  address: PublicKey,
  options: { from?: bigint; attempts?: number; delayMs?: number } = {},
): Promise<bigint> {
  const { from, attempts = 10, delayMs = 600 } = options
  let last = 0n

  for (let i = 0; i < attempts; i++) {
    last = BigInt(await connection.getBalance(address, 'confirmed'))
    if (from === undefined || last !== from) return last
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  // Esgotou a espera: devolve o que leu por último em vez de travar. Quem
  // chamou compara com o esperado e decide se isso é um problema.
  return last
}

/**
 * Divide o pote igual ao programa: arredondamento sobra para o protocolo.
 *
 * Os percentuais vêm do Config on-chain — passe os lidos de lá, não valores
 * fixos, senão o cliente mostra uma conta diferente da que o programa faz.
 */
export function splitPot(
  pot: bigint,
  winnerBps: number,
  houseBps: number,
): { winner: bigint; treasury: bigint; house: bigint } {
  const winner = (pot * BigInt(winnerBps)) / BPS_DENOMINATOR
  const house = (pot * BigInt(houseBps)) / BPS_DENOMINATOR
  return { winner, house, treasury: pot - winner - house }
}

export type ConfigState = {
  authority: PublicKey
  referee: PublicKey
  minStake: bigint
  maxStake: bigint
  paused: boolean
  winnerBps: number
  houseBps: number
  protocolBps: number
}

export async function fetchConfig(connection: Connection): Promise<ConfigState | null> {
  const [pda] = configPda()
  const info = await connection.getAccountInfo(pda, 'confirmed')
  if (!info) return null

  const data = new Uint8Array(info.data)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8

  const key = () => {
    const k = new PublicKey(data.subarray(offset, offset + 32))
    offset += 32
    return k
  }
  const authority = key()
  const referee = key()

  const minStake = view.getBigUint64(offset, true)
  offset += 8
  const maxStake = view.getBigUint64(offset, true)
  offset += 8
  const paused = view.getUint8(offset) === 1
  offset += 2 // paused + bump

  // Config ainda não migrado não tem estes campos: vale o padrão do programa.
  const migrado = data.length >= offset + 6
  const winnerBps = migrado ? view.getUint16(offset, true) || 9_000 : 9_000
  const houseBps = migrado ? view.getUint16(offset + 2, true) || 500 : 500
  const protocolBps = migrado ? view.getUint16(offset + 4, true) || 500 : 500

  return { authority, referee, minStake, maxStake, paused, winnerBps, houseBps, protocolBps }
}
