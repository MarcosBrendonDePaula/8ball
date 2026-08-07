/**
 * Prova de auditoria permanente, em devnet.
 *
 * Joga uma partida de verdade, grava o replay ON-CHAIN junto da liquidação, e
 * depois lê os bytes de volta da blockchain e reproduz a partida do zero —
 * sem usar nada além do que está gravado lá.
 *
 * É este ciclo que sustenta a promessa: daqui a anos, com o site fora do ar,
 * qualquer pessoa consegue conferir quem ganhou.
 *
 * Uso: bun scripts/devnet-replay.ts <pagador.json>
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  createMatchIx,
  fetchMatchRecord,
  joinMatchIx,
  matchIdFromUuid,
  readBalance,
  recordPda,
  settleMatchIx,
} from '@zinc-pool/chain-client'
import { DEFAULT_CUE, ENGINE_VERSION } from '@zinc-pool/engine-physics'
import {
  REPLAY_VERSION,
  decodeReplay,
  encodeAngle,
  encodePower,
  encodeReplay,
  replayProves,
  verifyReplay,
  type Replay,
} from '@zinc-pool/replay'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')

const load = (path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))

const payer = load(process.argv[2] ?? '')
const referee = load('keypairs/referee.json')

const sol = (n: bigint | number) => (Number(n) / LAMPORTS_PER_SOL).toFixed(6)

async function send(ixs: Parameters<Transaction['add']>, signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, {
    commitment: 'confirmed',
  })
}

// ------------------------------------------------- 1. joga a partida local

console.log('1) Jogando uma partida e montando o replay')

const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 19 + 7) % 256)

/** Tacadas espalhadas, sem aleatório — o replay precisa ser reproduzível. */
const shots = Array.from({ length: 50 }, (_, i) => ({
  angle: encodeAngle((((i * 47) % 360) * Math.PI) / 180),
  power: encodePower(0.55 + ((i * 7) % 40) / 100),
  spinX: 0,
  spinY: 0,
}))

const replay: Replay = {
  version: REPLAY_VERSION,
  mode: 'eightball',
  engineVersion: ENGINE_VERSION,
  seed,
  cues: [DEFAULT_CUE, DEFAULT_CUE],
  shots,
  decisions: [],
}

const bytes = encodeReplay(replay)
const verificacao = verifyReplay(replay)

console.log(`   ${shots.length} tacadas · ${bytes.length} bytes`)
console.log(`   tacadas aplicadas: ${verificacao.shotsApplied}`)
console.log(`   vencedor pela simulação: ${verificacao.winner === null ? 'indefinido' : `jogador ${verificacao.winner + 1}`}`)

if (verificacao.winner === null) {
  console.error('\nA partida de teste não chegou a um vencedor. Ajuste as tacadas.')
  process.exit(1)
}

const winnerIndex = verificacao.winner

// --------------------------------------------------- 2. mesa com dois jogadores

console.log('\n2) Criando a mesa em devnet')

const alice = Keypair.generate()
const bob = Keypair.generate()

await send(
  [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: alice.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: bob.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }),
  ],
  [payer],
)

const STAKE = BigInt(0.01 * LAMPORTS_PER_SOL)
const matchId = matchIdFromUuid(randomUUID())

await send(
  [createMatchIx({ creator: alice.publicKey, matchId, stake: STAKE, timeoutSeconds: 3600n })],
  [alice],
)
await send([joinMatchIx({ opponent: bob.publicKey, matchId })], [bob])

console.log(`   mesa ${sol(STAKE)} SOL, dois depósitos confirmados`)

// ------------------------------------------ 3. liquida gravando o replay

console.log('\n3) settle_match gravando o replay ON-CHAIN')

const vencedor = winnerIndex === 0 ? alice.publicKey : bob.publicKey

const assinatura = await send(
  [
    settleMatchIx({
      referee: referee.publicKey,
      matchId,
      creator: alice.publicKey,
      winner: vencedor,
      resultHash: verificacao.replayHash,
      replay: bytes,
    }),
  ],
  [referee],
)
console.log(`   ok ${assinatura}`)

// -------------------------------------- 4. lê de volta e reproduz do zero

console.log('\n4) Lendo o registro de volta da blockchain')

const [pda] = recordPda(matchId)
const registro = await fetchMatchRecord(connection, matchId)

if (!registro) {
  console.error('   Registro não encontrado on-chain.')
  process.exit(1)
}

console.log(`   conta      ${pda.toBase58()}`)
console.log(`   vencedor   ${registro.winner.toBase58().slice(0, 8)}…`)
console.log(`   pote       ${sol(registro.pot)} SOL`)
console.log(`   replay     ${registro.replay.length} bytes`)

const info = await connection.getAccountInfo(pda, 'confirmed')
console.log(`   aluguel    ${sol(info?.lamports ?? 0)} SOL (permanência)`)

console.log('\n5) Reproduzindo a partida SÓ com os bytes da chain')

// A partir daqui, nada vem do nosso lado — só o que está gravado.
const doOnChain = decodeReplay(registro.replay)
const prova = replayProves(doOnChain, {
  winner: winnerIndex,
  resultHash: registro.resultHash,
})

console.log(`   ${doOnChain.shots.length} tacadas decodificadas`)
console.log(`   modalidade ${doOnChain.mode}`)
console.log(`   prova: ${prova.valid ? 'CONFERE' : `FALHOU — ${prova.reason}`}`)

if (!prova.valid) process.exit(1)

// ------------------------------------------------- 6. tentativa de fraude

console.log('\n6) Tentando declarar o outro jogador como vencedor')

const mentira = replayProves(doOnChain, {
  winner: (winnerIndex === 0 ? 1 : 0) as 0 | 1,
  resultHash: registro.resultHash,
})
console.log(`   ${mentira.valid ? '*** FRAUDE PASSOU ***' : `recusado — ${mentira.reason}`}`)

if (mentira.valid) process.exit(1)

console.log('\nAuditoria permanente funcionando.')
console.log(`Solscan: https://solscan.io/account/${pda.toBase58()}?cluster=devnet`)
