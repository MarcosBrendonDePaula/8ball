import { explorerAddressUrl } from '@/config'
import { connection } from '@/wallet/balances'
import { fetchPlayerHistory } from '@zinc-pool/chain-client'
import { decodeReplay, verifyReplay } from '@zinc-pool/replay'
import { PublicKey } from '@solana/web3.js'
import { formatAmount } from '@zinc-pool/protocol'

/**
 * Histórico de partidas, lido da blockchain.
 *
 * Não há banco de dados por trás disto, e é o ponto: cada partida liquidada
 * deixa um `MatchRecord` permanente e público. O jogador vê o histórico mesmo
 * que o nosso servidor esteja fora do ar, e pode refazer a consulta com
 * qualquer RPC — sem confiar na nossa versão dos fatos.
 *
 * Cada linha traz o link para a conta no explorer e, o que importa de verdade,
 * a CONFERÊNCIA do replay: os bytes gravados são reproduzidos aqui, no
 * navegador do jogador, e o vencedor calculado é comparado com o declarado.
 */

export type HistoryEntry = {
  matchId: string
  pda: string
  won: boolean
  pot: string
  settledAt: number
  /** O replay reproduzido confirma o vencedor gravado? */
  verificado: 'confere' | 'divergiu' | 'erro'
  motivo: string | null
}

export async function loadHistory(address: string): Promise<HistoryEntry[]> {
  const registros = await fetchPlayerHistory(connection, new PublicKey(address))

  return registros.map((r) => {
    const matchId = Buffer.from(r.matchId).toString('hex')
    const base = {
      matchId,
      pda: r.pda.toBase58(),
      won: r.won,
      pot: r.pot.toString(),
      settledAt: r.settledAt,
    }

    // Reproduzir custa alguns milissegundos por partida e é a única coisa aqui
    // que o jogador não poderia obter olhando o explorer.
    try {
      const conferido = verifyReplay(decodeReplay(r.replay))
      const vencedorGravado = r.won ? 0 : 1
      const bate =
        conferido.winner !== null &&
        (conferido.winner === vencedorGravado) === r.winner.equals(new PublicKey(address))

      return {
        ...base,
        verificado: bate ? ('confere' as const) : ('divergiu' as const),
        motivo: bate ? null : 'o replay aponta outro vencedor',
      }
    } catch (err) {
      // Formato ou física de outra versão: nada disso é fraude, e chamar de
      // divergência assustaria à toa. A partida continua auditável — só exige
      // a versão do código que a gravou, que é justamente o motivo de a versão
      // viajar dentro do replay.
      return { ...base, verificado: 'erro' as const, motivo: explicar(err) }
    }
  })
}

export function renderHistory(entradas: HistoryEntry[], symbol: string): string {
  if (entradas.length === 0) {
    return `<p class="empty">Nenhuma partida liquidada ainda.</p>`
  }

  return `<ul class="historico">
    ${entradas.map((e) => linha(e, symbol)).join('')}
  </ul>`
}

function linha(e: HistoryEntry, symbol: string): string {
  const quando = new Date(e.settledAt * 1000).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return `<li class="hist-linha ${e.won ? 'venceu' : 'perdeu'}">
    <span class="hist-resultado">${e.won ? 'Vitória' : 'Derrota'}</span>
    <span class="hist-pote">${formatAmount(e.pot)} ${symbol}</span>
    <span class="hist-quando">${quando}</span>
    <span class="hist-prova hist-${e.verificado}" title="${e.motivo ?? 'O replay gravado reproduz este resultado.'}">
      ${SELO[e.verificado]}
    </span>
    <a class="hist-link" href="${explorerAddressUrl(e.pda)}" target="_blank" rel="noopener">
      ver na chain ↗
    </a>
  </li>`
}

const SELO: Record<HistoryEntry['verificado'], string> = {
  confere: '✓ replay confere',
  divergiu: '⚠ replay diverge',
  erro: '· não verificável',
}

/** Traduz a falha de verificação para algo que o jogador entenda. */
function explicar(err: unknown): string {
  const texto = String(err)

  if (/Versão de replay não suportada/.test(texto)) {
    return 'Gravada com uma versão anterior do formato. Continua auditável com o código daquela época.'
  }
  if (/física v/.test(texto)) {
    return 'Gravada com uma versão anterior da física. Continua auditável com a engine daquela época.'
  }
  return texto.slice(0, 120)
}
