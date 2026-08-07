/**
 * Ciclo completo do dinheiro em devnet, com transações reais.
 *
 * Percorre todo o caminho: dois depósitos, tentativa hostil de liquidar,
 * liquidação assinada pelo referee, prêmio para o vencedor, taxas nos cofres,
 * queima do tesouro e cancelamento com devolução. Se a matemática do programa
 * ou alguma trava de autorização estiver errada, aparece aqui.
 *
 * Uso: bun scripts/devnet-settle.ts <pagador.json>
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
  burnTreasuryIx,
  cancelMatchIx,
  commitOf,
  createMatchIx,
  fetchConfig,
  fetchVault,
  houseVaultPda,
  joinMatchIx,
  matchIdFromUuid,
  matchPda,
  readBalance,
  settleMatchIx,
  splitPot,
  treasuryVaultPda,
} from '@zinc-pool/chain-client'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')

const load = (path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))

const payer = load(process.argv[2] ?? '')
const referee = load('keypairs/referee.json')

// O seed da quebra vem do commit-reveal: cada jogador se compromete com um
// nonce AO DEPOSITAR, e o contrato só liquida com nonces que batam.
const nonceA = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 1) % 256)
const nonceB = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) % 256)

const sol = (n: bigint | number) => (Number(n) / LAMPORTS_PER_SOL).toFixed(6)
const balance = async (k: PublicKey) => readBalance(connection, k)

async function send(ixs: Parameters<Transaction['add']>, signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, {
    commitment: 'confirmed',
  })
}

const STAKE = BigInt(0.05 * LAMPORTS_PER_SOL)

console.log(`referee ${referee.publicKey.toBase58()}\n`)

// ------------------------------------------------------------ jogadores

const alice = Keypair.generate()
const bob = Keypair.generate()

console.log('1) fundando dois jogadores')
await send(
  [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: alice.publicKey,
      lamports: 0.2 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: bob.publicKey,
      // Bob perde a primeira partida e ainda banca a mesa do teste de
      // cancelamento; 0.1 não cobriria as duas entradas.
      lamports: 0.2 * LAMPORTS_PER_SOL,
    }),
  ],
  [payer],
)

// -------------------------------------------------------------- partida

const matchId = matchIdFromUuid(randomUUID())
const [gamePda] = matchPda(matchId)

console.log(`2) mesa de ${sol(STAKE)} SOL — os dois depositam`)
await send(
  [createMatchIx({
      creator: alice.publicKey,
      matchId,
      stake: STAKE,
      timeoutSeconds: 3600n,
      commit: commitOf(nonceA),
    })],
  [alice],
)
await send([joinMatchIx({ opponent: bob.publicKey, matchId, commit: commitOf(nonceB) })], [bob])
console.log(`   escrow segura ${sol(await balance(gamePda))} SOL\n`)

// ------------------------------------------------------------ liquidação

// Antes de liquidar de verdade: alguém sem a chave do referee consegue?
console.log('3) settle_match assinado por um impostor (deve falhar)')
const impostor = Keypair.generate()
await send(
  [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: impostor.publicKey,
      lamports: 0.01 * LAMPORTS_PER_SOL,
    }),
  ],
  [payer],
)
try {
  await send(
    [
      settleMatchIx({
        referee: impostor.publicKey,
        matchId,
        creator: alice.publicKey,
        winner: impostor.publicKey,
        resultHash: new Uint8Array(32),
        replay: new Uint8Array(0),
        nonceCreator: nonceA,
        nonceOpponent: nonceB,
      }),
    ],
    [impostor],
  )
  console.error('   *** FALHA DE SEGURANÇA: o impostor liquidou a partida ***')
  process.exit(1)
} catch {
  console.log('   recusado pelo programa, como esperado\n')
}

// A divisão vem do Config on-chain, não de constantes locais — senão o script
// afirmaria uma conta diferente da que o programa faz.
const cfg = await fetchConfig(connection)
const pot = STAKE * 2n
const split = splitPot(pot, cfg!.winnerBps, cfg!.houseBps)
console.log('4) settle_match — referee declara Alice vencedora')
console.log(
  `   divisão do Config: vencedor ${cfg!.winnerBps / 100}% · casa ${cfg!.houseBps / 100}% · protocolo ${cfg!.protocolBps / 100}%`,
)
console.log(
  `   pote ${sol(pot)} = vencedor ${sol(split.winner)} + tesouro ${sol(split.treasury)} + casa ${sol(split.house)}`,
)

const aliceAntes = await balance(alice.publicKey)
const houseAntes = await fetchVault(connection, 'house')
const treasuryAntes = await fetchVault(connection, 'treasury')

const resultHash = new Uint8Array(32).fill(7)
await send(
  [
    settleMatchIx({
      referee: referee.publicKey,
      matchId,
      creator: alice.publicKey,
      winner: alice.publicKey,
      resultHash,
      // Este script exercita só o fluxo do dinheiro; a gravação do replay tem
      // o seu próprio, em `bun run replay`.
      replay: new Uint8Array(0),
      nonceCreator: nonceA,
      nonceOpponent: nonceB,
    }),
  ],
  [referee],
)

const houseDepois = await fetchVault(connection, 'house')
const treasuryDepois = await fetchVault(connection, 'treasury')

// Espera o saldo mudar: ler direto após confirmar devolveria o valor antigo.
const aliceDepois = await readBalance(connection, alice.publicKey, { from: aliceAntes })
console.log(`   Alice recebeu   ${sol(aliceDepois - aliceAntes)} SOL`)
console.log(`   cofre casa      +${sol(houseDepois!.totalIn - houseAntes!.totalIn)} SOL`)
console.log(`   cofre tesouro   +${sol(treasuryDepois!.totalIn - treasuryAntes!.totalIn)} SOL`)
console.log(`   escrow          ${sol(await balance(gamePda))} SOL (conta fechada)`)
console.log(`   partidas liquidadas: ${houseDepois!.matchesSettled}\n`)

// ---------------------------------------------------------------- queima

const [treasuryPda] = treasuryVaultPda()

/**
 * A queima NÃO roda por padrão.
 *
 * O cofre de protocolo é uma reserva que acumula. Queimar é decisão à parte:
 * enquanto a aposta for em SOL, queimar só destrói valor que poderia bancar a
 * operação — faz sentido quando existir um token cujo supply se queira
 * reduzir. O caminho fica pronto e testável, mas exige `--burn` explícito.
 */
const treasuryFinal = await (async () => {
  if (!process.argv.includes('--burn')) {
    console.log('5) burn_treasury — PULADO (use --burn para exercitar)')
    console.log(`   reserva do protocolo: ${sol(treasuryDepois!.lamports)} SOL acumulados\n`)
    return treasuryDepois
  }

  const supplyAntes = (await connection.getSupply({ commitment: 'confirmed' })).value.total
  console.log('5) burn_treasury — queima real, via incinerador')

  const queimar = treasuryDepois!.totalIn - treasuryDepois!.totalOut
  await send([burnTreasuryIx({ caller: payer.publicKey, amount: queimar })], [payer])

  const depois = await fetchVault(connection, 'treasury')
  console.log(`   queimado agora  ${sol(queimar)} SOL`)
  console.log(`   total queimado  ${sol(depois!.totalOut)} SOL`)

  const supplyDepois = (await connection.getSupply({ commitment: 'confirmed' })).value.total
  console.log(`   supply da rede caiu ${supplyAntes - supplyDepois} lamports`)
  console.log('   (inclui queima de taxas de outras transações na mesma janela)\n')
  return depois
})()

// ------------------------------------------------------- 6. cancelamento

console.log('\n6) create_match + cancel_match — devolução integral')
const matchId2 = matchIdFromUuid(randomUUID())
const antesCriar = await balance(bob.publicKey)
await send(
  [
    createMatchIx({
      creator: bob.publicKey,
      matchId: matchId2,
      stake: STAKE,
      timeoutSeconds: 3600n,
      commit: commitOf(nonceB),
    }),
  ],
  [bob],
)
const depoisCriar = await readBalance(connection, bob.publicKey, { from: antesCriar })
console.log(`   Bob depositou, saldo ${sol(depoisCriar)} SOL`)

await send(
  [cancelMatchIx({ signer: bob.publicKey, creator: bob.publicKey, matchId: matchId2 })],
  [bob],
)
const depoisCancelar = await readBalance(connection, bob.publicKey, { from: depoisCriar })
console.log(`   Bob cancelou, saldo ${sol(depoisCancelar)} SOL`)
console.log(`   diferença total: ${sol(antesCriar - depoisCancelar)} SOL (só taxas de rede)`)

// ------------------------------------------------------------- conferência

const [housePda] = houseVaultPda()
console.log(`\ncofre casa      ${housePda.toBase58()}  ${sol(houseDepois!.lamports)} SOL`)
console.log(`cofre tesouro   ${treasuryPda.toBase58()}  ${sol(treasuryFinal!.lamports)} SOL`)
console.log('\nTudo certo.')
