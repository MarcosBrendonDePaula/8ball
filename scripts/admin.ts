/**
 * Administração do programa `pool_escrow`.
 *
 * Uso:
 *   bun scripts/admin.ts show
 *   bun scripts/admin.ts init      <authority.json>
 *   bun scripts/admin.ts set-keys  <authority.json>
 *   bun scripts/admin.ts pause     <authority.json>
 *   bun scripts/admin.ts unpause   <authority.json>
 *
 * As chaves de operação vêm de `keypairs/{referee,house,treasury}.json`, que
 * o git ignora. Elas precisam ser PERSISTENTES: a do referee é a única que
 * consegue liquidar partidas, e perdê-la trava toda liquidação até uma troca
 * por `set_config`.
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  PROGRAM_ID,
  burnTreasuryIx,
  configPda,
  fetchConfig,
  fetchVault,
  houseVaultPda,
  fetchProvenance,
  migrateConfigIx,
  provenancePda,
  publishProvenanceIx,
  setSplitsIx,
  MIN_WINNER_BPS,
  initVaultsIx,
  initializeIx,
  treasuryVaultPda,
  withdrawHouseIx,
} from '@zinc-pool/chain-client'
import { sha256 } from '@noble/hashes/sha2.js'

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')

/** Tamanho do Config já com os campos de divisão. */
const Config_LEN = 8 + 32 * 2 + 8 * 2 + 1 + 1 + 2 * 3

const MIN_STAKE = BigInt(0.01 * LAMPORTS_PER_SOL)
const MAX_STAKE = BigInt(5 * LAMPORTS_PER_SOL)

const load = (path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))

function loadOperational(name: string): PublicKey {
  const path = `keypairs/${name}.json`
  if (!existsSync(path)) {
    throw new Error(`Faltando ${path}. Gere com: solana-keygen new -o ${path}`)
  }
  return load(path).publicKey
}

const ixDiscriminator = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8)

/** Serializa `Option<T>` do Borsh: 1 byte de presença + valor. */
const optionPubkey = (key: PublicKey | null): Uint8Array =>
  key ? Uint8Array.from([1, ...key.toBytes()]) : Uint8Array.from([0])

const optionU64 = (value: bigint | null): Uint8Array => {
  if (value === null) return Uint8Array.from([0])
  const out = new Uint8Array(9)
  out[0] = 1
  new DataView(out.buffer).setBigUint64(1, value, true)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function setConfigIx(params: {
  authority: PublicKey
  referee: PublicKey | null
  minStake: bigint | null
  maxStake: bigint | null
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
        ixDiscriminator('set_config'),
        optionPubkey(params.referee),
        optionU64(params.minStake),
        optionU64(params.maxStake),
      ),
    ),
  })
}

function setPausedIx(authority: PublicKey, paused: boolean): TransactionInstruction {
  const [config] = configPda()
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concat(ixDiscriminator('set_paused'), Uint8Array.from([paused ? 1 : 0]))),
  })
}

async function show(): Promise<void> {
  const [config] = configPda()
  const info = await connection.getAccountInfo(config, 'confirmed')

  console.log(`programa  ${PROGRAM_ID.toBase58()}`)
  console.log(`config    ${config.toBase58()}`)
  console.log(`rpc       ${RPC}\n`)

  if (!info) {
    console.log('Config ainda não inicializado. Rode: bun scripts/admin.ts init <authority.json>')
    return
  }

  const data = info.data
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8
  const readKey = () => {
    const key = new PublicKey(data.subarray(offset, offset + 32))
    offset += 32
    return key.toBase58()
  }

  console.log(`authority ${readKey()}`)
  console.log(`referee   ${readKey()}`)
  const min = view.getBigUint64(offset, true)
  offset += 8
  const max = view.getBigUint64(offset, true)
  offset += 8
  console.log(`entrada   ${Number(min) / LAMPORTS_PER_SOL} .. ${Number(max) / LAMPORTS_PER_SOL} SOL`)
  console.log(`pausado   ${view.getUint8(offset) === 1 ? 'SIM' : 'não'}`)

  const cfg = await fetchConfig(connection)
  if (cfg) {
    const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`
    const migrado = data.length >= Config_LEN
    console.log(
      `divisão   vencedor ${pct(cfg.winnerBps)} · casa ${pct(cfg.houseBps)} · protocolo ${pct(cfg.protocolBps)}` +
        (migrado ? '' : '  (padrão — Config ainda não migrado)'),
    )
    console.log(`          rake total ${pct(10_000 - cfg.winnerBps)} · piso do vencedor ${pct(MIN_WINNER_BPS)}`)
  }

  const sol = (n: bigint) => (Number(n) / LAMPORTS_PER_SOL).toFixed(6)

  const { ENGINE_VERSION } = await import('@zinc-pool/engine-physics')
  const proc = await fetchProvenance(connection, ENGINE_VERSION)
  const [procPda] = provenancePda(ENGINE_VERSION)

  console.log(`
procedência da física v${ENGINE_VERSION}  ${procPda.toBase58()}`)
  if (!proc) {
    console.log('  não publicada. Rode: bun scripts/admin.ts provenance <authority.json> <url>')
  } else {
    console.log(`  digest      ${proc.physicsDigest}`)
    console.log(`  spec sha256 ${Buffer.from(proc.specHash).toString('hex')}`)
    console.log(`  arquivado   ${proc.specUri}`)
  }

  for (const kind of ['house', 'treasury'] as const) {
    const [pda] = kind === 'house' ? houseVaultPda() : treasuryVaultPda()
    const vault = await fetchVault(connection, kind)
    console.log(`
cofre ${kind}  ${pda.toBase58()}`)
    if (!vault) {
      console.log('  não criado. Rode: bun scripts/admin.ts init-vaults <authority.json>')
      continue
    }
    console.log(`  saldo       ${sol(vault.lamports)} SOL`)
    console.log(`  entrou      ${sol(vault.totalIn)} SOL`)
    console.log(`  ${kind === 'house' ? 'sacado    ' : 'queimado  '}  ${sol(vault.totalOut)} SOL`)
    if (kind === 'house') console.log(`  partidas    ${vault.matchesSettled}`)
  }
}

async function send(ix: TransactionInstruction, signer: Keypair): Promise<void> {
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer], {
    commitment: 'confirmed',
  })
  console.log(`ok ${sig}\n`)
}

// ------------------------------------------------------------------ main

const [command, keypairPath] = process.argv.slice(2)

if (command === 'show') {
  await show()
} else if (!command || !keypairPath) {
  console.error(
    'uso: bun scripts/admin.ts <show|init|migrate|init-vaults|set-keys|set-splits|provenance|withdraw|burn|pause|unpause> [keypair.json] [args]',
  )
  process.exit(1)
} else {
  const authority = load(keypairPath)
  console.log(`authority ${authority.publicKey.toBase58()}\n`)

  switch (command) {
    case 'init': {
      const [config] = configPda()
      if (await connection.getAccountInfo(config, 'confirmed')) {
        console.error('Config já existe. Use `set-keys` para alterar.')
        process.exit(1)
      }
      await send(
        initializeIx({
          authority: authority.publicKey,
          referee: loadOperational('referee'),
          minStake: MIN_STAKE,
          maxStake: MAX_STAKE,
        }),
        authority,
      )
      break
    }

    case 'set-keys':
      await send(
        setConfigIx({
          authority: authority.publicKey,
          referee: loadOperational('referee'),
          minStake: MIN_STAKE,
          maxStake: MAX_STAKE,
        }),
        authority,
      )
      break

    case 'migrate':
      await send(migrateConfigIx(authority.publicKey), authority)
      break

    case 'set-splits': {
      const [w, h, p] = process.argv.slice(4).map(Number)
      if (!w || !h || p === undefined || Number.isNaN(p)) {
        console.error('uso: bun scripts/admin.ts set-splits <authority.json> <vencedor%> <casa%> <protocolo%>')
        console.error('ex:  bun scripts/admin.ts set-splits key.json 95 2.5 2.5')
        process.exit(1)
      }
      const bps = (percent: number) => Math.round(percent * 100)
      const winnerBps = bps(w)
      if (winnerBps < MIN_WINNER_BPS) {
        console.error(`O vencedor não pode ficar abaixo de ${MIN_WINNER_BPS / 100}% — limite do programa.`)
        process.exit(1)
      }
      await send(
        setSplitsIx({
          authority: authority.publicKey,
          winnerBps,
          houseBps: bps(h),
          protocolBps: bps(p),
        }),
        authority,
      )
      break
    }

    case 'provenance': {
      // Ancora on-chain o que permite reimplementar a física sem o nosso
      // código: impressão digital, hash do documento e onde ele está.
      const uri = process.argv[4]
      if (!uri) {
        console.error('uso: bun scripts/admin.ts provenance <authority.json> <url-do-spec>')
        console.error('ex:  ... provenance key.json https://arweave.net/<txid>')
        process.exit(1)
      }

      const { readFileSync: ler } = await import('node:fs')
      const { sha256 } = await import('@noble/hashes/sha2.js')
      const doc = ler('docs/PHYSICS-SPEC.md')
      const specHash = sha256(new Uint8Array(doc))

      const { ENGINE_VERSION, PHYSICS_DIGEST } = await import('@zinc-pool/engine-physics')

      console.log(`física v${ENGINE_VERSION} · digest ${PHYSICS_DIGEST}`)
      console.log(`spec ${doc.length} bytes · sha256 ${Buffer.from(specHash).toString('hex').slice(0, 16)}…`)
      console.log(`uri  ${uri}
`)

      await send(
        publishProvenanceIx({
          authority: authority.publicKey,
          engineVersion: ENGINE_VERSION,
          physicsDigest: PHYSICS_DIGEST,
          specHash,
          specUri: uri,
        }),
        authority,
      )
      break
    }

    case 'init-vaults':
      await send(initVaultsIx(authority.publicKey), authority)
      break

    case 'withdraw': {
      const valor = process.argv[4]
      const destino = process.argv[5]
      if (!valor || !destino) {
        console.error('uso: bun scripts/admin.ts withdraw <authority.json> <SOL> <destino>')
        process.exit(1)
      }
      await send(
        withdrawHouseIx({
          authority: authority.publicKey,
          destination: new PublicKey(destino),
          amount: BigInt(Math.round(Number(valor) * LAMPORTS_PER_SOL)),
        }),
        authority,
      )
      break
    }

    case 'burn': {
      const valor = process.argv[4]
      if (!valor) {
        console.error('uso: bun scripts/admin.ts burn <keypair.json> <SOL>')
        process.exit(1)
      }
      await send(
        burnTreasuryIx({
          caller: authority.publicKey,
          amount: BigInt(Math.round(Number(valor) * LAMPORTS_PER_SOL)),
        }),
        authority,
      )
      break
    }

    case 'pause':
      await send(setPausedIx(authority.publicKey, true), authority)
      break

    case 'unpause':
      await send(setPausedIx(authority.publicKey, false), authority)
      break

    default:
      console.error(`comando desconhecido: ${command}`)
      process.exit(1)
  }

  await show()
}
