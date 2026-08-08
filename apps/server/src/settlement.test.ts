import { describe, expect, test } from 'bun:test'
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { MAX_ATTEMPTS, settleMatch, type SettlementDeps } from '@/settlement'
import type { MatchEnded } from '@/match'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * A liquidação é o único ponto em que o servidor manda dinheiro para alguém.
 * O que precisa estar certo é a IDENTIFICAÇÃO — vencedor e criador — e o que
 * ele faz quando a chain recusa.
 */

const A = Keypair.generate().publicKey.toBase58()
const B = Keypair.generate().publicKey.toBase58()
/** 16 bytes = 32 caracteres hex. É o tamanho que o contrato espera. */
const MATCH = 'ab'.repeat(16)

const replay = Uint8Array.from({ length: 63 }, (_, i) => i)

const nonces: [Uint8Array, Uint8Array] = [
  Uint8Array.from({ length: 32 }, (_, i) => i),
  Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
]

const fim = (over: Partial<MatchEnded> = {}): MatchEnded => ({
  winner: 0,
  reason: 'regras',
  replay,
  nonces,
  ...over,
})

function deps(send?: (ix: TransactionInstruction) => Promise<string>): SettlementDeps {
  return {
    connection: {} as never,
    referee: Keypair.generate(),
    ...(send ? { send } : {}),
    log: () => {},
  }
}

describe('quem recebe', () => {
  test('o vencedor 0 é o criador', async () => {
    let ix: TransactionInstruction | null = null
    const r = await settleMatch(
      deps(async (i) => {
        ix = i
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim({ winner: 0 }),
    )

    expect(r.ok).toBe(true)
    // Referee assina; criador e vencedor entram como contas.
    const chaves = ix!.keys.map((k) => k.pubkey.toBase58())
    expect(chaves).toContain(A)
  })

  test('o vencedor 1 é o oponente', async () => {
    let ix: TransactionInstruction | null = null
    await settleMatch(
      deps(async (i) => {
        ix = i
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim({ winner: 1 }),
    )

    expect(ix!.keys.map((k) => k.pubkey.toBase58())).toContain(B)
  })

  test('o que viaja é o hash do replay, não os bytes', async () => {
    let ix: TransactionInstruction | null = null
    await settleMatch(
      deps(async (i) => {
        ix = i
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim(),
    )

    const dados = Buffer.from(ix!.data).toString('hex')

    // Os BYTES não viajam mais: armazená-los custava ~0,0057 SOL por partida,
    // contra 0,00023 do hash. O que os liga a esta partida é o compromisso.
    expect(dados).not.toContain(Buffer.from(replay).toString('hex'))
    expect(dados).toContain(Buffer.from(sha256(replay)).toString('hex'))

    // E o tamanho, que denuncia um replay truncado antes mesmo de hashear.
    const tamanho = Buffer.alloc(2)
    tamanho.writeUInt16LE(replay.length)
    expect(dados).toContain(tamanho.toString('hex'))
  })
})

describe('o que não é liquidado', () => {
  test('partida sem vencedor vai para reembolso', async () => {
    let chamou = false
    const r = await settleMatch(
      deps(async () => {
        chamou = true
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim({ winner: null, reason: 'tempo' }),
    )

    // O contrato paga UM vencedor; empate técnico só sai pelo reembolso.
    expect(r.ok).toBe(false)
    expect(chamou).toBe(false)
    expect((r as { retriable: boolean }).retriable).toBe(false)
  })

  test('match_id com tamanho errado é recusado antes de gastar taxa', async () => {
    let chamou = false
    const r = await settleMatch(
      deps(async () => {
        chamou = true
        return 'sig'
      }),
      'abcd',
      [A, B],
      fim(),
    )

    expect(r.ok).toBe(false)
    expect(chamou).toBe(false)
  })

  test('carteira inválida não vira transação', async () => {
    const r = await settleMatch(deps(async () => 'sig'), MATCH, ['nao-e-uma-chave', B], fim())
    expect(r.ok).toBe(false)
  })
})

describe('quando a chain recusa', () => {
  test('tenta de novo e consegue', async () => {
    let n = 0
    const r = await settleMatch(
      deps(async () => {
        if (++n < MAX_ATTEMPTS) throw new Error('blockhash not found')
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim(),
    )

    expect(r.ok).toBe(true)
    expect(n).toBe(MAX_ATTEMPTS)
  }, 30_000)

  test('desistir é sinalizado, não silencioso', async () => {
    const r = await settleMatch(
      deps(async () => {
        throw new Error('RPC morto')
      }),
      MATCH,
      [A, B],
      fim(),
    )

    // Desistir não perde dinheiro: a mesa fica na chain e o varredor devolve
    // depois do prazo. Reembolso é pior que pagar o vencedor, e muito melhor
    // que travar.
    expect(r.ok).toBe(false)
    expect((r as { retriable: boolean }).retriable).toBe(true)
  }, 30_000)

  test('já liquidada não é tratada como falha para repetir', async () => {
    let n = 0
    const r = await settleMatch(
      deps(async () => {
        n++
        throw new Error('Allocate: account Address already in use')
      }),
      MATCH,
      [A, B],
      fim(),
    )

    expect(r.ok).toBe(false)
    expect((r as { retriable: boolean }).retriable).toBe(false)
    expect(n).toBe(1)
  })
})

describe('sem revelação não há liquidação', () => {
  test('partida sem nonces vai para reembolso', async () => {
    // O contrato recusaria de qualquer forma — e é bom que recuse: são os
    // nonces que provam que o seed veio de uma escolha dos dois jogadores,
    // feita antes de qualquer um saber o resultado.
    let chamou = false
    const r = await settleMatch(
      deps(async () => {
        chamou = true
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim({ nonces: null }),
    )

    expect(r.ok).toBe(false)
    expect(chamou).toBe(false)
  })

  test('os nonces vão na instrução, na ordem dos jogadores', async () => {
    let ix: TransactionInstruction | null = null
    await settleMatch(
      deps(async (i) => {
        ix = i
        return 'sig'
      }),
      MATCH,
      [A, B],
      fim(),
    )

    const dados = Buffer.from(ix!.data).toString('hex')
    expect(dados).toContain(Buffer.from(nonces[0]).toString('hex'))
    expect(dados).toContain(Buffer.from(nonces[1]).toString('hex'))
  })
})
