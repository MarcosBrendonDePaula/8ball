/**
 * Verificação de ponta a ponta do estado real.
 *
 * Confere o que está NA CHAIN e NOS SERVIÇOS, não o que deveria estar. Cada
 * item passa ou falha por conta própria; o script termina com código != 0 se
 * algo estiver quebrado, para poder ser usado em CI.
 *
 * Uso: bun scripts/verify.ts
 */

import { Connection, PublicKey } from '@solana/web3.js'
import {
  PROGRAM_ID,
  configPda,
  fetchVault,
  houseVaultPda,
  treasuryVaultPda,
} from '@zinc-pool/chain-client'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8787'
const WEB = process.env.WEB_URL ?? 'http://localhost:5173'

const connection = new Connection(RPC, 'confirmed')
const sol = (n: bigint | number) => (Number(n) / 1e9).toFixed(6)

let falhas = 0

function check(ok: boolean, titulo: string, detalhe = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${titulo}${detalhe ? `  ${detalhe}` : ''}`)
  if (!ok) falhas++
}

// ------------------------------------------------------------------ chain

console.log('\nCHAIN')

const programa = await connection.getAccountInfo(PROGRAM_ID, 'confirmed')
check(programa !== null, 'programa publicado', PROGRAM_ID.toBase58())
check(programa?.executable === true, 'programa executável', `${programa?.data.length ?? 0} bytes`)

const [config] = configPda()
const configInfo = await connection.getAccountInfo(config, 'confirmed')
check(configInfo !== null, 'config existe', config.toBase58())

if (configInfo) {
  const d = configInfo.data
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  let o = 8
  const key = () => {
    const k = new PublicKey(d.subarray(o, o + 32))
    o += 32
    return k
  }
  const authority = key()
  const referee = key()
  o += 64 // house e treasury legados, hoje substituídos pelos cofres PDA
  const min = v.getBigUint64(o, true)
  o += 8
  const max = v.getBigUint64(o, true)
  o += 8
  const pausado = v.getUint8(o) === 1

  console.log(`       authority ${authority.toBase58()}`)
  console.log(`       referee   ${referee.toBase58()}`)
  check(!pausado, 'programa não pausado')
  check(min > 0n && max >= min, 'faixa de entrada', `${sol(min)} .. ${sol(max)} SOL`)

  // A chave do referee precisa estar em disco, senão nenhuma partida liquida.
  const arquivo = Bun.file('keypairs/referee.json')
  if (await arquivo.exists()) {
    const secret = Uint8Array.from((await arquivo.json()) as number[])
    const { Keypair } = await import('@solana/web3.js')
    const local = Keypair.fromSecretKey(secret).publicKey
    check(local.equals(referee), 'chave do referee confere com o Config')
  } else {
    check(false, 'keypairs/referee.json presente')
  }

  // A authority não pode ser a mesma chave que vive no servidor.
  const faucet = Bun.file('apps/server/.devnet-faucet.json')
  if (await faucet.exists()) {
    const { Keypair } = await import('@solana/web3.js')
    const local = Keypair.fromSecretKey(Uint8Array.from((await faucet.json()) as number[]))
    check(
      !local.publicKey.equals(authority),
      'faucet do servidor é chave separada da authority',
      local.publicKey.toBase58(),
    )
    const saldo = await connection.getBalance(local.publicKey, 'confirmed')
    check(saldo > 0.1 * 1e9, 'faucet tem saldo', `${sol(saldo)} SOL`)
  }
}

// ------------------------------------------------------------------ cofres

console.log('\nCOFRES')

for (const kind of ['house', 'treasury'] as const) {
  const [pda] = kind === 'house' ? houseVaultPda() : treasuryVaultPda()
  const vault = await fetchVault(connection, kind)
  check(vault !== null, `cofre ${kind} criado`, pda.toBase58())
  if (!vault) continue

  console.log(
    `       saldo ${sol(vault.lamports)}  entrou ${sol(vault.totalIn)}  ` +
      `${kind === 'house' ? 'sacado' : 'queimado'} ${sol(vault.totalOut)}` +
      (kind === 'house' ? `  partidas ${vault.matchesSettled}` : ''),
  )

  // Contabilidade: o que saiu nunca pode passar do que entrou.
  check(vault.totalOut <= vault.totalIn, `contabilidade ${kind} fecha`)
}

// ---------------------------------------------------------------- partidas

console.log('\nPARTIDAS ABERTAS')

const partidas = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 114 }] })
if (partidas.length === 0) {
  console.log('       nenhuma')
} else {
  for (const { pubkey, account } of partidas) {
    const d = account.data
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
    const criador = new PublicKey(d.subarray(24, 56)).toBase58()
    const estado = v.getUint8(96) === 0 ? 'waiting' : 'committed'
    const prazo = Number(v.getBigInt64(105, true))
    const min = Math.round((prazo * 1000 - Date.now()) / 60000)
    console.log(
      `       ${pubkey.toBase58().slice(0, 8)}… ${estado.padEnd(9)} ${sol(account.lamports)} SOL  ` +
        `criador ${criador.slice(0, 4)}…${criador.slice(-4)}  ` +
        (min > 0 ? `expira em ${min} min` : `EXPIRADA há ${-min} min — destravável`),
    )
  }
}

// ---------------------------------------------------------------- serviços

console.log('\nSERVIÇOS')

try {
  const res = await fetch(`${SERVER}/api/health`)
  const body = (await res.json()) as { ok: boolean; cluster: string; programId: string }
  check(res.ok && body.ok, 'servidor responde', SERVER)
  check(body.programId === PROGRAM_ID.toBase58(), 'servidor aponta para o programa certo')
  check(body.cluster === 'devnet', 'servidor em devnet', body.cluster)
} catch {
  check(false, 'servidor responde', SERVER)
}

try {
  const res = await fetch(WEB)
  check(res.ok, 'cliente web responde', WEB)
} catch {
  check(false, 'cliente web responde', WEB)
}

// O faucet precisa recusar endereço inválido, não estourar.
try {
  const res = await fetch(`${SERVER}/api/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'nao-e-um-endereco' }),
  })
  const body = (await res.json()) as { ok: boolean }
  check(!body.ok, 'faucet recusa endereço inválido')
} catch {
  check(false, 'faucet recusa endereço inválido')
}

// ------------------------------------------------------------------ fim

console.log(falhas === 0 ? '\nTudo certo.\n' : `\n${falhas} verificação(ões) falharam.\n`)
process.exit(falhas === 0 ? 0 : 1)
