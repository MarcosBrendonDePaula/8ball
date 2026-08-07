/**
 * Distribui SOL de devnet entre as carteiras de operação.
 *
 * Existe porque cada papel precisa da SUA PRÓPRIA chave. Juntar tudo numa
 * chave só é o erro que este script desfaz: a carteira do faucet vive dentro
 * do processo do servidor, e se ela também for a authority do programa, quem
 * comprometer o servidor consegue publicar uma versão nova do programa e
 * drenar todo o escrow.
 *
 * Papéis e por que cada saldo:
 *   authority  paga deploys (buffer de ~2 SOL, devolvido depois) — fica no WSL
 *   faucet     entrega SOL de teste — vive no servidor, saldo pequeno de propósito
 *   referee    paga taxa das liquidações — centavos bastam
 *   house      só recebe, não assina nada
 *   treasury   só recebe, não assina nada
 *
 * Uso: bun scripts/fund.ts <authority.json>
 */

import { readFileSync } from 'node:fs'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')

const sol = (n: number) => Math.round(n * LAMPORTS_PER_SOL)

/** Quanto cada carteira deve ter ao final. */
const ALVOS: Array<{ nome: string; arquivo: string; alvo: number }> = [
  { nome: 'faucet', arquivo: 'keypairs/faucet.json', alvo: 1.5 },
  { nome: 'referee', arquivo: 'keypairs/referee.json', alvo: 0.3 },
]

/** A authority precisa manter isto para bancar um deploy futuro. */
const RESERVA_AUTHORITY = sol(2.5)

const load = (path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))

const keypairPath = process.argv[2]
if (!keypairPath) {
  console.error('uso: bun scripts/fund.ts <authority.json>')
  process.exit(1)
}

const authority = load(keypairPath)
const disponivel = await connection.getBalance(authority.publicKey, 'confirmed')

console.log(`authority ${authority.publicKey.toBase58()}`)
console.log(`saldo     ${(disponivel / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`)

const transferencias: Array<{ nome: string; para: PublicKey; lamports: number }> = []

for (const { nome, arquivo, alvo } of ALVOS) {
  const conta = load(arquivo).publicKey
  const atual = await connection.getBalance(conta, 'confirmed')
  const falta = sol(alvo) - atual

  const estado = `${nome.padEnd(9)} ${conta.toBase58()}  ${(atual / LAMPORTS_PER_SOL).toFixed(4)}`
  if (falta <= 0) {
    console.log(`${estado} -> já tem o alvo de ${alvo}`)
    continue
  }
  console.log(`${estado} -> enviar ${(falta / LAMPORTS_PER_SOL).toFixed(4)}`)
  transferencias.push({ nome, para: conta, lamports: falta })
}

const total = transferencias.reduce((soma, t) => soma + t.lamports, 0)

if (total === 0) {
  console.log('\nNada a fazer.')
  process.exit(0)
}

// Nunca esvaziar a authority: sem reserva ela não consegue nem pagar taxa,
// e recuperar isso exige outro faucet.
if (disponivel - total < RESERVA_AUTHORITY) {
  console.error(
    `\nA authority ficaria com menos que a reserva de ${RESERVA_AUTHORITY / LAMPORTS_PER_SOL} SOL.`,
  )
  console.error('Reduza os alvos ou traga mais SOL antes de distribuir.')
  process.exit(1)
}

const tx = new Transaction()
for (const t of transferencias) {
  tx.add(
    SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: t.para,
      lamports: t.lamports,
    }),
  )
}

const assinatura = await sendAndConfirmTransaction(connection, tx, [authority], {
  commitment: 'confirmed',
})
console.log(`\nok ${assinatura}\n`)

for (const { nome, arquivo } of ALVOS) {
  const conta = load(arquivo).publicKey
  const saldo = await connection.getBalance(conta, 'confirmed')
  console.log(`${nome.padEnd(9)} ${(saldo / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
}
const restante = await connection.getBalance(authority.publicKey, 'confirmed')
console.log(`authority ${(restante / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
