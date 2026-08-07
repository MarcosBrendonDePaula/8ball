import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { claimTimeoutIx, fetchAllMatches } from '@zinc-pool/chain-client'

/**
 * Varredor de mesas vencidas.
 *
 * Uma mesa em que os dois depositaram e ninguém liquidou fica com o dinheiro
 * preso na PDA. O contrato já resolve isso — `claim_timeout` devolve a entrada
 * de cada um depois do prazo — mas alguém precisa CHAMAR.
 *
 * Até aqui esse alguém era uma pessoa clicando "Destravar" no painel. Se
 * ninguém abrisse o painel, o dinheiro simplesmente ficava lá.
 *
 * ISTO É SEGURO DE AUTOMATIZAR, e por uma razão específica do contrato:
 *
 *   pub struct ClaimTimeout {
 *       /// Qualquer um pode acionar depois do prazo — de propósito.
 *       pub caller: Signer,
 *       #[account(mut, close = creator, ...)]
 *       pub game: Account<Game>,
 *       #[account(mut, address = game.creator)] pub creator,
 *       #[account(mut, address = game.opponent)] pub opponent,
 *   }
 *
 * Quem aciona NÃO escolhe o destino: `close = creator` e os `address =` fixam
 * as duas contas contra o que está gravado na partida. O varredor não pode
 * desviar um lamport — ele só paga a taxa da transação. Por isso pode rodar
 * com a chave do referee, que já existe no servidor e já só paga taxa; não é
 * preciso criar nem guardar nenhuma chave nova.
 */

/** De quanto em quanto tempo o varredor olha a chain. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * Folga depois do prazo antes de o varredor agir.
 *
 * O relógio do validador e o do servidor não são o mesmo, e o contrato compara
 * com `Clock::get()`. Chamar no segundo exato daria `NotExpiredYet` e gastaria
 * taxa à toa. Cinco minutos também dão margem para uma liquidação legítima que
 * esteja a caminho chegar primeiro.
 */
export const GRACE_AFTER_DEADLINE_S = 5 * 60

/** Quantas mesas por passada. Evita uma rajada de transações num arranque. */
export const MAX_PER_SWEEP = 5

export type SweepReport = {
  examinadas: number
  vencidas: number
  destravadas: number
  puladas: { motivo: string; pda: string }[]
  erros: { pda: string; erro: string }[]
}

export type SweeperDeps = {
  connection: Connection
  /** Paga só a taxa. A chave do referee serve e já está aqui. */
  payer: Keypair
  /**
   * Envia a instrução. Injetável de propósito.
   *
   * O trabalho deste módulo é DECIDIR em que mesa mexer; o transporte é
   * detalhe. Separar os dois permite testar as decisões — que são as que
   * podem devolver dinheiro na hora errada — sem imitar meio web3.js.
   */
  send?: (ix: TransactionInstruction) => Promise<string>
  /**
   * Uma partida está em andamento neste servidor?
   *
   * A guarda que impede o varredor de anular jogo vivo. O prazo on-chain é
   * generoso (uma hora), mas uma partida longa pode passar dele, e devolver o
   * dinheiro no meio de uma disputa seria pior do que deixá-lo preso.
   */
  isLive: (matchIdHex: string) => boolean
  now?: () => number
  log?: (msg: string) => void
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/**
 * Uma passada. Devolve o que fez, para o teste e para o log.
 *
 * Separado do agendamento de propósito: assim o teste chama direto, com a
 * chain falsa que quiser, sem esperar cinco minutos.
 */
export async function sweepExpired(deps: SweeperDeps): Promise<SweepReport> {
  const agora = Math.floor((deps.now?.() ?? Date.now()) / 1000)
  const report: SweepReport = {
    examinadas: 0,
    vencidas: 0,
    destravadas: 0,
    puladas: [],
    erros: [],
  }

  const mesas = await fetchAllMatches(deps.connection)
  report.examinadas = mesas.length

  for (const mesa of mesas) {
    // Só mesa com os dois depósitos tem o que devolver. `waiting` se resolve
    // por `cancel_match`, que é outro caminho.
    if (mesa.state !== 'committed') continue
    if (agora < mesa.deadline + GRACE_AFTER_DEADLINE_S) continue

    report.vencidas++

    const id = hex(mesa.matchId)

    if (deps.isLive(id)) {
      report.puladas.push({ motivo: 'partida em andamento', pda: mesa.pda.toBase58() })
      continue
    }
    if (!mesa.opponent) {
      // Não deveria acontecer: `committed` implica oponente. Se acontecer, é
      // bug em outro lugar, e chamar a instrução só produziria erro de conta.
      report.puladas.push({ motivo: 'comprometida sem oponente', pda: mesa.pda.toBase58() })
      continue
    }
    if (report.destravadas >= MAX_PER_SWEEP) {
      report.puladas.push({ motivo: 'limite da passada', pda: mesa.pda.toBase58() })
      continue
    }

    try {
      const enviar = deps.send ?? envioPadrao(deps)
      const assinatura = await enviar(
        claimTimeoutIx({
          caller: deps.payer.publicKey,
          matchId: mesa.matchId,
          creator: mesa.creator,
          opponent: mesa.opponent as PublicKey,
        }),
      )
      report.destravadas++
      deps.log?.(`[sweeper] devolvida ${id.slice(0, 8)}… · ${assinatura}`)
    } catch (err) {
      // Falhar numa mesa não pode parar as outras: a mais comum é corrida com
      // outra chamada que já destravou, e nesse caso o dinheiro já voltou.
      report.erros.push({ pda: mesa.pda.toBase58(), erro: String(err).slice(0, 200) })
    }
  }

  return report
}

const envioPadrao =
  (deps: SweeperDeps) =>
  (ix: TransactionInstruction): Promise<string> =>
    sendAndConfirmTransaction(deps.connection, new Transaction().add(ix), [deps.payer], {
      commitment: 'confirmed',
    })

/** Agenda a varredura. Devolve como parar. */
export function startSweeper(deps: SweeperDeps): () => void {
  let rodando = false

  const passada = async () => {
    // Não deixa duas passadas se sobreporem: um RPC lento faria a segunda
    // tentar destravar as mesmas mesas da primeira.
    if (rodando) return
    rodando = true
    try {
      const r = await sweepExpired(deps)
      if (r.destravadas > 0 || r.erros.length > 0) {
        deps.log?.(
          `[sweeper] ${r.destravadas} destravada(s), ${r.vencidas} vencida(s), ${r.erros.length} erro(s)`,
        )
      }
    } catch (err) {
      deps.log?.(`[sweeper] falhou a passada: ${String(err).slice(0, 200)}`)
    } finally {
      rodando = false
    }
  }

  const timer = setInterval(() => void passada(), SWEEP_INTERVAL_MS)
  timer.unref?.()

  // Uma passada logo ao subir: se o servidor ficou fora do ar, há mesas
  // esperando desde antes.
  void passada()

  return () => clearInterval(timer)
}
