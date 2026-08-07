import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { settleMatchIx } from '@zinc-pool/chain-client'
import type { MatchEnded } from '@/match'

/**
 * Liquidação: paga o vencedor e grava o replay on-chain.
 *
 * É o passo que faltava para o jogo ser um jogo. Sem ele, uma partida disputada
 * até o fim ficava com o dinheiro parado na PDA até o prazo — e aí o VARREDOR
 * a devolvia como empate. Quem ganhou recebia a entrada de volta em vez do
 * pote, e o replay nunca chegava à blockchain.
 *
 * A liquidação é assinada pelo referee. É o ponto do sistema que exige
 * confiança, e ele existe porque a Solana não roda a nossa física: alguém
 * precisa dizer quem ganhou. O que limita o estrago é que a afirmação vem
 * acompanhada do replay, e qualquer pessoa reproduz os bytes e confere — um
 * referee mentiroso é pego, e o piso de 85% para o vencedor está no contrato,
 * fora do alcance dele.
 */

export type SettleOutcome =
  | { ok: true; signature: string }
  | { ok: false; reason: string; retriable: boolean }

export type SettlementDeps = {
  connection: Connection
  /** Precisa ser a chave gravada no `Config` on-chain. */
  referee: Keypair
  send?: (ix: TransactionInstruction) => Promise<string>
  log?: (msg: string) => void
}

/**
 * Quantas tentativas antes de desistir.
 *
 * Desistir não perde o dinheiro: a mesa continua na chain e o varredor a
 * devolve depois do prazo. Reembolso é pior que pagar o vencedor, mas é muito
 * melhor que travar.
 */
export const MAX_ATTEMPTS = 3

/** Espera entre tentativas. Curta: o prazo on-chain é de uma hora. */
export const RETRY_DELAY_MS = 5_000

/**
 * Liquida uma partida terminada.
 *
 * `players[0]` é sempre o criador da mesa — é assim que a partida é aberta, e
 * o contrato valida o criador contra o que está gravado na `Game`.
 */
export async function settleMatch(
  deps: SettlementDeps,
  matchIdHex: string,
  players: readonly [string, string],
  result: MatchEnded,
): Promise<SettleOutcome> {
  if (!result.nonces) {
    // Sem os nonces o contrato recusa a liquidação — e é bom que recuse: são
    // eles que provam que o seed veio de uma escolha dos dois jogadores.
    return { ok: false, reason: 'partida sem revelação; será reembolsada', retriable: false }
  }

  if (result.winner === null) {
    // Empate técnico não tem como ser liquidado: o contrato paga UM vencedor.
    // O caminho certo é o reembolso, que o varredor faz depois do prazo.
    return { ok: false, reason: 'partida sem vencedor; será reembolsada', retriable: false }
  }

  const matchId = Uint8Array.from(Buffer.from(matchIdHex, 'hex'))
  if (matchId.length !== 16) {
    return { ok: false, reason: `match_id inválido: ${matchIdHex}`, retriable: false }
  }

  let creator: PublicKey
  let winner: PublicKey
  try {
    creator = new PublicKey(players[0])
    winner = new PublicKey(players[result.winner])
  } catch {
    return { ok: false, reason: 'carteira inválida na partida', retriable: false }
  }

  const ix = settleMatchIx({
    referee: deps.referee.publicKey,
    matchId,
    creator,
    winner,
    replay: result.replay,
    nonceCreator: result.nonces[0],
    nonceOpponent: result.nonces[1],
  })

  const enviar = deps.send ?? envioPadrao(deps)

  for (let tentativa = 1; tentativa <= MAX_ATTEMPTS; tentativa++) {
    try {
      const signature = await enviar(ix)
      deps.log?.(
        `[settle] ${matchIdHex.slice(0, 8)}… vencedor ${players[result.winner].slice(0, 8)}… ` +
          `(${result.reason}) · ${signature}`,
      )
      return { ok: true, signature }
    } catch (err) {
      const texto = String(err)

      // Já liquidada: outra tentativa chegou primeiro. Não é falha.
      if (/already in use|AlreadySettled|NotSettleable/i.test(texto)) {
        return { ok: false, reason: 'já estava liquidada', retriable: false }
      }

      if (tentativa === MAX_ATTEMPTS) {
        deps.log?.(`[settle] desistiu de ${matchIdHex.slice(0, 8)}…: ${texto.slice(0, 200)}`)
        return { ok: false, reason: texto.slice(0, 200), retriable: true }
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    }
  }

  return { ok: false, reason: 'inalcançável', retriable: true }
}

const envioPadrao =
  (deps: SettlementDeps) =>
  (ix: TransactionInstruction): Promise<string> =>
    sendAndConfirmTransaction(deps.connection, new Transaction().add(ix), [deps.referee], {
      commitment: 'confirmed',
    })
