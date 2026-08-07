import '@/polyfills'
import '@/styles.css'
import './admin.css'

import { CLUSTER, explorerAddressUrl } from '@/config'
import { connection } from '@/wallet/balances'
import { PhantomWallet, getProvider, UserRejectedError } from '@/wallet/phantom'
import { claimTimeoutIx, hexToBytes } from '@zinc-pool/chain-client'
import { formatAmount } from '@zinc-pool/protocol'
import { PublicKey, Transaction } from '@solana/web3.js'
import { loadSnapshot, type AdminMatch, type AdminSnapshot } from './chain'

/**
 * Painel de administração.
 *
 * Lê tudo direto da blockchain. A única ação disponível é `claim_timeout`, e
 * ela está aqui por um motivo específico: qualquer um pode acioná-la depois do
 * prazo, e o dinheiro volta para os jogadores de qualquer forma. Não é poder
 * do administrador — é a válvula que impede fundos de ficarem presos se o
 * servidor ou o referee sumirem.
 *
 * As ações que EXIGEM a chave de autoridade (pausar, trocar referee, sacar do
 * cofre) ficam de fora de propósito. Essa chave não deve viver num navegador;
 * ela mora no WSL e se usa por `scripts/admin.ts`.
 */

const wallet = new PhantomWallet()
const root = document.getElementById('app')!

let snapshot: AdminSnapshot | null = null
let erro: string | null = null
let aviso: string | null = null
let ocupado: string | null = null

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const curto = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const sol = (lamports: bigint) => formatAmount(lamports)

/** Tempo restante em formato legível, ou quanto já passou. */
function restante(deadlineSeg: number): { texto: string; vencido: boolean } {
  const ms = deadlineSeg * 1000 - Date.now()
  const vencido = ms <= 0
  const total = Math.floor(Math.abs(ms) / 1000)

  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  const texto = h > 0 ? `${h}h ${m}min` : m > 0 ? `${m}min ${s}s` : `${s}s`
  return { texto: vencido ? `vencida há ${texto}` : texto, vencido }
}

// ------------------------------------------------------------------ ações

async function destravar(match: AdminMatch): Promise<void> {
  if (!match.opponent) {
    erro = 'Mesa sem oponente: quem cancela é o criador, pelo próprio jogo.'
    render()
    return
  }

  const publicKey = wallet.publicKey ?? (await wallet.connect())

  ocupado = match.pda
  erro = null
  aviso = null
  render()

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

    const tx = new Transaction().add(
      claimTimeoutIx({
        caller: publicKey,
        matchId: hexToBytes(match.matchIdHex),
        creator: new PublicKey(match.creator),
        opponent: new PublicKey(match.opponent),
      }),
    )
    tx.feePayer = publicKey
    tx.recentBlockhash = blockhash

    const assinada = await wallet.signTransaction(tx)
    const assinatura = await connection.sendRawTransaction(assinada.serialize(), {
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction({ signature: assinatura, blockhash, lastValidBlockHeight }, 'confirmed')

    aviso = `Destravada. Os depósitos voltaram para os dois jogadores. (${curto(assinatura)})`
    await atualizar()
  } catch (e) {
    erro = e instanceof UserRejectedError ? 'Você recusou na Phantom.' : String(e)
  } finally {
    ocupado = null
    render()
  }
}

async function atualizar(): Promise<void> {
  try {
    snapshot = await loadSnapshot()
    if (!erro) erro = null
  } catch (e) {
    erro = `Falha ao ler a blockchain: ${String(e)}`
  }
  render()
}

// ----------------------------------------------------------------- render

function renderConfig(s: AdminSnapshot): string {
  if (!s.config) {
    return `<p class="empty">Config não encontrado on-chain.</p>`
  }
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`

  return `
    <dl class="rows">
      <div class="row"><dt>Programa</dt><dd><a href="${explorerAddressUrl(s.programId)}" target="_blank" rel="noopener">${esc(curto(s.programId))}</a></dd></div>
      <div class="row"><dt>Autoridade</dt><dd>${esc(curto(s.config.authority.toBase58()))}</dd></div>
      <div class="row"><dt>Referee</dt><dd>${esc(curto(s.config.referee.toBase58()))}</dd></div>
      <div class="row"><dt>Entrada</dt><dd>${sol(s.config.minStake)} — ${sol(s.config.maxStake)} SOL</dd></div>
      <div class="row">
        <dt>Divisão</dt>
        <dd>vencedor ${pct(s.config.winnerBps)} · casa ${pct(s.config.houseBps)} · protocolo ${pct(s.config.protocolBps)}</dd>
      </div>
      <div class="row">
        <dt>Estado</dt>
        <dd>${s.config.paused ? '<strong class="alerta">PAUSADO</strong>' : 'operando'}</dd>
      </div>
    </dl>`
}

function renderCofre(titulo: string, cofre: AdminSnapshot['house'], rotuloSaida: string): string {
  if (!cofre) return `<div class="cofre"><h3>${titulo}</h3><p class="empty">não criado</p></div>`

  return `
    <div class="cofre">
      <h3>${titulo}</h3>
      <div class="cofre-valor">${sol(cofre.lamports)} <span>SOL</span></div>
      <dl class="mini">
        <div><dt>entrou</dt><dd>${sol(cofre.totalIn)}</dd></div>
        <div><dt>${rotuloSaida}</dt><dd>${sol(cofre.totalOut)}</dd></div>
        ${cofre.matchesSettled > 0n ? `<div><dt>partidas</dt><dd>${cofre.matchesSettled}</dd></div>` : ''}
      </dl>
      <a class="cofre-link" href="${explorerAddressUrl(cofre.pda)}" target="_blank" rel="noopener">${esc(curto(cofre.pda))}</a>
    </div>`
}

function renderMesa(m: AdminMatch): string {
  const { texto, vencido } = restante(m.deadline)
  const pote = m.stakeLamports * (m.opponent ? 2n : 1n)

  // Só faz sentido destravar partida comprometida e vencida: sem oponente,
  // quem devolve o depósito é o criador cancelando.
  const podeDestravar = vencido && m.state === 'committed'

  return `
    <tr class="${vencido ? 'vencida' : ''}">
      <td>
        <a href="${explorerAddressUrl(m.pda)}" target="_blank" rel="noopener">${esc(curto(m.pda))}</a>
      </td>
      <td><span class="tag" data-estado="${m.state}">${m.state === 'waiting' ? 'aguardando' : 'comprometida'}</span></td>
      <td class="num">${sol(m.stakeLamports)}</td>
      <td class="num">${sol(pote)}</td>
      <td class="num destaque">${sol(m.escrowLamports)}</td>
      <td>${esc(curto(m.creator))}</td>
      <td>${m.opponent ? esc(curto(m.opponent)) : '<span class="fraco">—</span>'}</td>
      <td class="${vencido ? 'alerta' : ''}">${esc(texto)}</td>
      <td>
        ${
          podeDestravar
            ? `<button class="destravar" data-pda="${m.pda}" ${ocupado ? 'disabled' : ''}>
                 ${ocupado === m.pda ? '<span class="spinner"></span>' : 'Destravar'}
               </button>`
            : ''
        }
      </td>
    </tr>`
}

function render(): void {
  const s = snapshot

  const totalTravado = s
    ? s.matches.reduce((soma, m) => soma + m.escrowLamports, 0n)
    : 0n

  root.innerHTML = `
    <div class="netbar" data-real="${CLUSTER === 'mainnet-beta'}">
      <span class="netbar-dot"></span>
      <strong>${esc(CLUSTER === 'mainnet-beta' ? 'MAINNET' : CLUSTER.toUpperCase())}</strong>
      <span class="netbar-text">Painel de administração — leitura direta da blockchain.</span>
    </div>

    <header class="admin-header">
      <h1>Administração</h1>
      <div class="admin-acoes">
        <span class="fraco">${s ? `atualizado ${new Date(s.fetchedAt).toLocaleTimeString('pt-BR')}` : 'carregando…'}</span>
        <button id="atualizar" class="ghost">Atualizar</button>
      </div>
    </header>

    ${erro ? `<div class="notice" data-tone="error">${esc(erro)}</div>` : ''}
    ${aviso ? `<div class="notice" data-tone="ok">${esc(aviso)}</div>` : ''}

    ${
      !s
        ? '<p class="empty">Lendo a blockchain…</p>'
        : `
      <section>
        <h2 class="section">Configuração</h2>
        ${renderConfig(s)}
      </section>

      <section>
        <h2 class="section">Cofres</h2>
        <div class="cofres">
          ${renderCofre('Casa', s.house, 'sacado')}
          ${renderCofre('Protocolo', s.treasury, 'queimado')}
        </div>
      </section>

      <section>
        <h2 class="section">
          Mesas ${s.matches.length ? `<span>${s.matches.length}</span>` : ''}
          ${totalTravado > 0n ? `<span class="travado">${sol(totalTravado)} SOL travados</span>` : ''}
        </h2>
        ${
          s.matches.length
            ? `<div class="tabela-wrap">
                 <table class="tabela">
                   <thead>
                     <tr>
                       <th>conta</th><th>estado</th><th class="num">entrada</th>
                       <th class="num">pote</th><th class="num">no cofre</th>
                       <th>criador</th><th>oponente</th><th>prazo</th><th></th>
                     </tr>
                   </thead>
                   <tbody>${s.matches.map(renderMesa).join('')}</tbody>
                 </table>
               </div>`
            : '<p class="empty">Nenhuma mesa aberta.</p>'
        }
      </section>`
    }

    <p class="footnote">
      Pausar, trocar o referee e sacar do cofre exigem a chave de autoridade, que
      não deve viver num navegador. Use <code>bun scripts/admin.ts</code>.
    </p>`

  root.querySelector('#atualizar')?.addEventListener('click', () => void atualizar())

  root.querySelectorAll<HTMLElement>('.destravar').forEach((botao) => {
    botao.addEventListener('click', () => {
      const mesa = snapshot?.matches.find((m) => m.pda === botao.dataset.pda)
      if (mesa) void destravar(mesa)
    })
  })
}

// O prazo corre; sem redesenhar, a coluna congelaria numa contagem antiga.
setInterval(() => {
  if (snapshot && !ocupado) render()
}, 1000)

// Releitura periódica da chain. 15s é frequente o bastante para acompanhar e
// espaçado o bastante para não estourar o limite do RPC.
setInterval(() => {
  if (!ocupado) void atualizar()
}, 15_000)

render()
void atualizar()
if (getProvider()) void wallet.autoConnect()
