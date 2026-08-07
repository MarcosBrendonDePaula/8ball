import { explorerAddressUrl } from '@/config'
import { connection } from '@/wallet/balances'
import { fetchPlayerHistory, winnerMatchesReplay } from '@zinc-pool/chain-client'
import { sha256 } from '@noble/hashes/sha2.js'
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
  /** Versão do FORMATO e da FÍSICA com que a partida foi gravada. */
  versao: { formato: number; fisica: number } | null
}

export async function loadHistory(address: string): Promise<HistoryEntry[]> {
  const registros = await fetchPlayerHistory(connection, new PublicKey(address))

  return registros.map((r) => {
    const matchId = Buffer.from(r.matchId).toString('hex')

    // Os dois primeiros campos do replay são a versão do formato e a da
    // física. Lidos direto dos bytes, sem decodificar: valem mesmo quando o
    // resto do replay é de uma versão que este código não sabe ler.
    const versao =
      r.replay.length >= 3 ? { formato: r.replay[0]!, fisica: r.replay[2]! } : null

    const base = {
      matchId,
      pda: r.pda.toBase58(),
      won: r.won,
      pot: r.pot.toString(),
      settledAt: r.settledAt,
      versao,
    }

    /*
     * Reproduzir custa alguns milissegundos por partida e é a única coisa aqui
     * que o jogador não obteria olhando o explorer.
     *
     * QUATRO checagens, e agora elas cobrem a promessa inteira:
     *
     *   1. o hash dos bytes bate com o `result_hash` gravado — o replay não foi
     *      trocado depois da liquidação
     *   2. o seed veio dos nonces gravados — não foi escolhido pelo servidor
     *   3. o replay reproduz até um vencedor — é uma partida completa
     *   4. esse vencedor é a CARTEIRA que recebeu — o jogador 0 é o criador,
     *      e o criador está gravado
     *
     * A quarta era impossível até o registro passar a guardar o criador: o
     * replay chama os jogadores de 0 e 1, e sem essa ligação um referee
     * comprometido pagava o perdedor com a auditoria dizendo "confere".
     *
     * A segunda era impossível até os nonces irem para a chain: sem elas, nada
     * amarrava o seed a coisa nenhuma, e o servidor fabricava uma partida
     * inteira que nunca aconteceu.
     */
    try {
      const conferido = verifyReplay(decodeReplay(r.replay))

      if (!mesmosBytes(conferido.replayHash, r.resultHash)) {
        return {
          ...base,
          verificado: 'divergiu' as const,
          motivo: 'os bytes do replay não batem com o hash gravado na liquidação',
        }
      }

      if (conferido.winner === null) {
        return {
          ...base,
          verificado: 'erro' as const,
          motivo: 'o replay não chega a um vencedor',
        }
      }

      // O seed tem de ser o hash dos dois nonces gravados na liquidação.
      const esperado = sha256(concat(r.nonceCreator, r.nonceOpponent))
      if (!mesmosBytes(esperado, decodeReplay(r.replay).seed)) {
        return {
          ...base,
          verificado: 'divergiu' as const,
          motivo: 'o seed da quebra não veio dos nonces gravados',
        }
      }

      if (!winnerMatchesReplay(r, conferido.winner)) {
        return {
          ...base,
          verificado: 'divergiu' as const,
          motivo: 'quem recebeu o pote não é quem o replay diz que venceu',
        }
      }

      return { ...base, verificado: 'confere' as const, motivo: null }
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

  return `<ul class="mx-0 mt-0 mb-[18px] grid list-none gap-1.5 p-0">
    ${entradas.map((e) => linha(e, symbol)).join('')}
  </ul>`
}

/**
 * Cor do selo de conferência.
 *
 * O selo é a informação mais importante da linha: diz se a partida foi
 * conferida pelo próprio navegador, e não pela nossa palavra.
 */
const TOM: Record<HistoryEntry['verificado'], string> = {
  confere: 'text-chalk',
  divergiu: 'font-semibold text-[#e06c5b]',
  erro: 'opacity-50',
}

function linha(e: HistoryEntry, symbol: string): string {
  const quando = new Date(e.settledAt * 1000).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  // Só resultado e valor dividem a primeira linha; o resto ocupa a largura toda
  // logo abaixo, com `col-span-full`. Valores em `tabular-nums` porque a lista é
  // lida na vertical: dígito de largura variável desalinha a coluna.
  return `<li class="hist-linha group">
    <span class="font-semibold ${e.won ? 'text-chalk' : 'opacity-65'}">${e.won ? 'Vitória' : 'Derrota'}</span>
    <span class="tabular-nums opacity-80">${formatAmount(e.pot)} ${symbol}</span>
    <span class="col-span-full text-[11px] tabular-nums opacity-80">${quando}</span>
    <span class="col-span-full whitespace-nowrap text-[12px] ${TOM[e.verificado]}" title="${esc(e.motivo ?? 'O replay gravado reproduz este resultado.')}">
      ${SELO[e.verificado]}
    </span>
    <!-- A versão da física é o que decide se uma partida antiga ainda reproduz
         igual. Discreta, mas visível: quem não sabe o que é ignora; quem sabe,
         entende na hora por que um replay antigo não confere. -->
    <span class="col-span-full font-mono text-[10px]/none font-medium tracking-[0.02em] opacity-40 group-hover:opacity-75"
          title="Formato do replay e versão da física com que a partida foi jogada. Uma partida só reproduz igual na física que a gerou.">
      ${e.versao ? `fmt v${e.versao.formato} · fis v${e.versao.fisica}` : '—'}
    </span>
    <a class="col-span-full justify-self-start whitespace-nowrap text-[12px] opacity-70 hover:opacity-100"
       href="${explorerAddressUrl(e.pda)}" target="_blank" rel="noopener">
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

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const fora = new Uint8Array(a.length + b.length)
  fora.set(a)
  fora.set(b, a.length)
  return fora
}

const mesmosBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Escapa texto que vai para um atributo HTML. */
const esc = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
