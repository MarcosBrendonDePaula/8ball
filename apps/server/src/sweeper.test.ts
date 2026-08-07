import { describe, expect, test } from 'bun:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { GAME_ACCOUNT_SIZE } from '@zinc-pool/chain-client'
import { GRACE_AFTER_DEADLINE_S, MAX_PER_SWEEP, sweepExpired } from '@/sweeper'

/**
 * O varredor mexe em dinheiro de verdade, então o que importa testar é o que
 * ele DEIXA de fazer: não tocar em mesa viva, não tocar em mesa dentro do
 * prazo, e não parar tudo porque uma falhou.
 *
 * A chain é falsa. Testar contra a devnet aqui deixaria o teste lento e
 * dependente de rede — e o comportamento que interessa é de decisão, não de
 * transporte.
 */

const AGORA_S = 1_800_000_000
const AGORA_MS = AGORA_S * 1000

type MesaFalsa = {
  matchId: Uint8Array
  creator: PublicKey
  opponent: PublicKey | null
  state: 'waiting' | 'committed'
  deadline: number
}

/** Monta os bytes de uma conta `Game` como o programa a grava. */
function bytesDaMesa(m: MesaFalsa): Uint8Array {
  const data = new Uint8Array(GAME_ACCOUNT_SIZE)
  const view = new DataView(data.buffer)
  let o = 8

  data.set(m.matchId, o)
  o += 16
  data.set(m.creator.toBytes(), o)
  o += 32
  data.set((m.opponent ?? PublicKey.default).toBytes(), o)
  o += 32
  view.setBigUint64(o, 10_000_000n, true)
  o += 8
  view.setUint8(o, m.state === 'waiting' ? 0 : 1)
  o += 1
  view.setBigInt64(o, BigInt(AGORA_S - 7200), true)
  o += 8
  view.setBigInt64(o, BigInt(m.deadline), true)

  return data
}

function chainFalsa(mesas: MesaFalsa[]) {
  return {
    getProgramAccounts: async () =>
      mesas.map((m, i) => ({
        pubkey: new PublicKey(new Uint8Array(32).fill(i + 1)),
        account: { data: Buffer.from(bytesDaMesa(m)), lamports: 1_000_000 },
      })),
  }
}

const mesa = (over: Partial<MesaFalsa> = {}, i = 0): MesaFalsa => ({
  matchId: Uint8Array.from({ length: 16 }, () => i + 1),
  creator: new PublicKey(new Uint8Array(32).fill(100 + i)),
  opponent: new PublicKey(new Uint8Array(32).fill(200 + i)),
  state: 'committed',
  deadline: AGORA_S - GRACE_AFTER_DEADLINE_S - 60,
  ...over,
})

const deps = (mesas: MesaFalsa[], extra: Partial<Parameters<typeof sweepExpired>[0]> = {}) => ({
  connection: chainFalsa(mesas) as never,
  payer: Keypair.generate(),
  isLive: () => false,
  now: () => AGORA_MS,
  send: async () => 'assinatura'.padEnd(88, 'x'),
  ...extra,
})

describe('o que o varredor não toca', () => {
  test('mesa ainda dentro do prazo', async () => {
    const r = await sweepExpired(deps([mesa({ deadline: AGORA_S + 600 })]))

    expect(r.vencidas).toBe(0)
    expect(r.destravadas).toBe(0)
  })

  test('mesa vencida há pouco, dentro da folga', async () => {
    // O relógio do validador não é o do servidor, e o contrato compara com o
    // dele. Chamar cedo daria NotExpiredYet e gastaria taxa à toa.
    const r = await sweepExpired(deps([mesa({ deadline: AGORA_S - 10 })]))

    expect(r.vencidas).toBe(0)
  })

  test('mesa apenas aguardando oponente', async () => {
    // Não há o que devolver ao oponente: esse caso é `cancel_match`.
    const r = await sweepExpired(deps([mesa({ state: 'waiting' })]))

    expect(r.vencidas).toBe(0)
  })

  test('partida em andamento neste servidor', async () => {
    // A guarda que importa: devolver o dinheiro no meio de uma disputa seria
    // pior do que deixá-lo preso mais um pouco.
    const r = await sweepExpired(deps([mesa()], { isLive: () => true }))

    expect(r.vencidas).toBe(1)
    expect(r.destravadas).toBe(0)
    expect(r.puladas[0]?.motivo).toBe('partida em andamento')
  })

  test('comprometida sem oponente é anomalia, não é destravada', async () => {
    const r = await sweepExpired(deps([mesa({ opponent: null })]))

    expect(r.destravadas).toBe(0)
    expect(r.puladas[0]?.motivo).toBe('comprometida sem oponente')
  })
})

describe('o que ele faz', () => {
  test('destrava a mesa vencida', async () => {
    const r = await sweepExpired(deps([mesa()]))

    expect(r.vencidas).toBe(1)
    expect(r.destravadas).toBe(1)
    expect(r.erros).toHaveLength(0)
  })

  test('respeita o teto por passada', async () => {
    const muitas = Array.from({ length: MAX_PER_SWEEP + 3 }, (_, i) =>
      mesa({ matchId: Uint8Array.from({ length: 16 }, () => i + 1) }, i),
    )
    const r = await sweepExpired(deps(muitas))

    expect(r.destravadas).toBe(MAX_PER_SWEEP)
    expect(r.puladas.filter((p) => p.motivo === 'limite da passada')).toHaveLength(3)
  })

  test('uma mesa que falha não impede as outras', async () => {
    const duas = [mesa({}, 0), mesa({ matchId: Uint8Array.from({ length: 16 }, () => 2) }, 1)]
    let n = 0

    // A falha mais comum é corrida: outra chamada já destravou. Nesse caso o
    // dinheiro já voltou, e parar a varredura por isso deixaria as seguintes
    // presas até a próxima passada.
    const r = await sweepExpired(
      deps(duas, {
        send: async () => {
          if (n++ === 0) throw new Error('corrida: já destravada')
          return 'assinatura'.padEnd(88, 'x')
        },
      }),
    )

    expect(r.erros).toHaveLength(1)
    expect(r.destravadas).toBe(1)
  })
})
