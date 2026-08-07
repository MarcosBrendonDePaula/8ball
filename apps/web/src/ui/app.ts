import { explorerAddressUrl } from '@/config'
import { GameClient, type NetState } from '@/net/client'
import {
  PHANTOM_INSTALL_URL,
  PhantomWallet,
  UserRejectedError,
  WalletNotFoundError,
  getProvider,
  type WalletState,
} from '@/wallet/phantom'
import { loadHistory, renderHistory, type HistoryEntry } from '@/ui/history'
import { formatAmount, parseAmount, type GameMode, type Room } from '@zinc-pool/protocol'
import { GAME_MODES, GAME_MODE_INFO } from '@zinc-pool/engine-rules'

const wallet = new PhantomWallet()
const net = new GameClient(wallet)

let walletState: WalletState = { status: 'disconnected' }
let netState: NetState = net.state
let localError: string | null = null
/** Confirmação passageira, some na próxima ação. */
let notice: string | null = null
let busy = false

/** Preservado entre renders — o innerHTML recria os inputs a cada atualização. */
const form = { stake: '0.05', label: '', mode: 'eightball' as GameMode }

/**
 * Histórico do jogador, lido da chain.
 *
 * Fora do `netState` de propósito: não vem do nosso servidor, vem da
 * blockchain. Misturar as duas origens no mesmo estado esconderia justamente o
 * que torna o histórico confiável.
 */
let historico: HistoryEntry[] = []
let historicoCarregando = false
let historicoDe: string | null = null

/**
 * Recarrega o histórico quando a carteira muda.
 *
 * A leitura passa por `getProgramAccounts`, que é cara; refazê-la a cada
 * atualização de saldo deixaria o lobby lento sem mostrar nada de novo.
 */
function sincronizarHistorico(address: string | null): void {
  if (!address || address === historicoDe) return

  historicoDe = address
  historicoCarregando = true

  void loadHistory(address)
    .then((entradas) => {
      historico = entradas
    })
    .catch(() => {
      historico = []
    })
    .finally(() => {
      historicoCarregando = false
      render()
    })
}

const root = document.getElementById('app')!

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const symbol = () => netState.limits?.symbol ?? 'SOL'
const cluster = () => netState.limits?.cluster ?? '—'

function errorMessage(err: unknown): string {
  if (err instanceof UserRejectedError) return 'Você recusou a solicitação na Phantom.'
  if (err instanceof WalletNotFoundError) return 'Phantom não encontrada neste navegador.'
  if (err instanceof Error) return err.message
  return 'Erro inesperado.'
}

/** Envolve uma ação que fala com a carteira, tratando erro e estado ocupado. */
async function run(action: () => Promise<unknown>): Promise<void> {
  busy = true
  localError = null
  notice = null
  render()
  try {
    await action()
  } catch (err) {
    localError = errorMessage(err)
  } finally {
    busy = false
    render()
  }
}

// ------------------------------------------------------------------ ações

async function onConnect(): Promise<void> {
  if (!getProvider()) {
    window.open(PHANTOM_INSTALL_URL, '_blank', 'noopener')
    localError = 'Instale a Phantom e recarregue a página.'
    render()
    return
  }
  await run(() => wallet.connect())
}

function onCreate(): void {
  const stake = parseAmount(form.stake)
  if (stake === null || stake <= 0n) {
    localError = 'Valor de entrada inválido.'
    render()
    return
  }
  const { minStake, maxStake } = netState.limits ?? { minStake: '0', maxStake: '0' }
  if (stake < BigInt(minStake) || stake > BigInt(maxStake)) {
    localError = `A entrada deve ficar entre ${formatAmount(minStake)} e ${formatAmount(maxStake)} ${symbol()}.`
    render()
    return
  }
  void run(() => net.createRoom(stake.toString(), form.label, form.mode))
}

// ------------------------------------------------------------------ render

/**
 * Faixa de rede.
 *
 * Deliberadamente impossível de ignorar: confundir devnet com mainnet é como
 * alguém acaba apostando SOL de verdade achando que está testando. O texto diz
 * o que a rede SIGNIFICA, não só o nome dela.
 */
function renderNetworkBar(): string {
  const rede = cluster()
  const real = rede === 'mainnet-beta'

  const rotulo = real ? 'MAINNET' : rede.toUpperCase()
  const explicacao = real
    ? 'Dinheiro real. Cada mesa gasta SOL de verdade.'
    : rede === 'localnet'
      ? 'Rede local na sua máquina. Nada aqui existe fora dela.'
      : 'Rede de teste. O SOL usado aqui não tem valor nenhum.'

  return `
    <div class="netbar" data-real="${real}">
      <span class="netbar-dot" aria-hidden="true"></span>
      <strong class="flex-none font-mono text-[11px]/none font-bold tracking-[0.08em]">${esc(rotulo)}</strong>
      <span class="text-[11px] text-text-dim">${esc(explicacao)}</span>
    </div>`
}

function renderBadges(): string {
  const online = netState.connection === 'online'
  const conn = online ? 'conectado' : netState.connection === 'connecting' ? 'conectando…' : 'offline'
  const programa = netState.limits?.programId
  return `
    <div class="mb-5 flex flex-wrap gap-1.5">
      <span class="badge" data-tone="${online ? 'live' : 'warn'}">${conn}</span>
      <span class="badge" data-tone="live">escrow on-chain</span>
      ${
        programa
          ? `<a class="badge badge-link" href="${explorerAddressUrl(programa)}" target="_blank" rel="noopener"
                title="Contrato que guarda os depósitos">contrato ${esc(programa.slice(0, 4))}…${esc(programa.slice(-4))}</a>`
          : ''
      }
    </div>`
}

function renderGate(): string {
  const hasPhantom = Boolean(getProvider())
  const connected = walletState.status === 'connected'

  const button = connected
    ? `<button id="signin" ${busy ? 'disabled' : ''}>
         ${busy ? '<span class="spinner"></span>Aguardando a Phantom…' : 'Assinar login'}
       </button>`
    : `<button id="connect" ${busy ? 'disabled' : ''}>
         ${busy ? '<span class="spinner"></span>Conectando…' : hasPhantom ? 'Conectar Phantom' : 'Instalar Phantom'}
       </button>`

  return `
    ${renderBadges()}
    <div class="grid gap-2.5">
      ${button}
      ${connected ? '<button id="disconnect" class="ghost">Desconectar carteira</button>' : ''}
    </div>
    <p class="footnote">
      ${
        connected
          ? 'A assinatura de login é gratuita e não move fundos. Depósitos são transações separadas, que você aprova uma a uma.'
          : `Você vai jogar com ${esc(symbol())} de verdade na rede ${esc(cluster())}.`
      }
    </p>`
}

function renderMyRoom(room: Room): string {
  const waiting = room.state === 'waiting'
  const me = netState.address
  const other = room.creator === me ? room.opponent : room.creator
  const pot = (BigInt(room.stake) * 2n).toString()

  // Com a tela larga, a sala própria fica num painel centrado: ela é UMA
  // coisa só, e esticá-la por 1180px deixaria os rótulos longe dos valores.
  return `
    <div class="mx-auto max-w-[520px]">
      <section class="painel">    ${renderBadges()}
    <div class="notice" data-tone="info">
      ${
        waiting
          ? `Sua mesa está aberta e o depósito está travado no contrato. Sai da lista em <span id="countdown" class="font-mono text-text">…</span> se ninguém entrar — o dinheiro continua seu, basta cancelar.`
          : `Mesa fechada com <strong>${esc(short(other ?? '?'))}</strong>. Os dois depósitos estão no contrato.`
      }
    </div>

    <dl class="rows">
      <div class="row"><dt>Mesa</dt><dd>${esc(room.label)}</dd></div>
      <div class="row"><dt>Modalidade</dt><dd>${esc(GAME_MODE_INFO[room.mode].name)}</dd></div>
      <div class="row"><dt>Entrada</dt><dd><strong>${formatAmount(room.stake)} ${esc(symbol())}</strong></dd></div>
      <div class="row"><dt>Pote</dt><dd>${formatAmount(pot)} ${esc(symbol())}</dd></div>
      <div class="row"><dt>Vencedor leva</dt><dd>${formatAmount(((BigInt(pot) * 9000n) / 10000n).toString())} ${esc(symbol())}</dd></div>
      <div class="row"><dt>Adversário</dt><dd>${other ? esc(short(other)) : 'aguardando…'}</dd></div>
    </dl>

    <div class="grid gap-2.5">
      ${
        waiting
          ? `<button id="cancel" class="ghost" ${busy ? 'disabled' : ''} data-room="${room.id}">
               ${busy ? '<span class="spinner"></span>Cancelando…' : 'Cancelar e receber de volta'}
             </button>`
          : `<a class="botao-jogar" href="/mesa.html">Entrar na mesa</a>`
      }
    </div>
    <p class="footnote">
      ${
        waiting
          ? 'Cancelar é uma transação: a Phantom vai pedir aprovação e o depósito volta na hora.'
          : 'Os dois depósitos estão no contrato. A partida começa assim que os dois entrarem na mesa.'
      }
      </p>
      </section>
    </div>`
}

function renderRoomRow(room: Room): string {
  return `
    <li class="room">
      <div class="grid min-w-0 gap-[3px]">
        <span class="truncate text-[13px] font-medium">${esc(room.label)}</span>
        <span class="font-mono text-[11px]/none text-text-dim">${esc(GAME_MODE_INFO[room.mode].name)} · ${esc(short(room.creator))}</span>
      </div>
      <div class="flex flex-none items-center gap-2.5">
        <span class="font-mono text-xs/none font-medium text-gold">${formatAmount(room.stake)} ${esc(symbol())}</span>
        <button class="join w-auto px-3.5 py-2 text-xs/none" ${busy ? 'disabled' : ''} data-room="${room.id}">Entrar</button>
      </div>
    </li>`
}

/**
 * Faucet de SOL de teste. Só existe em devnet.
 */
function renderFaucet(): string {
  const balance = netState.lamports

  if (!netState.limits?.faucetAvailable) {
    return balance === 0n
      ? `<div class="notice" data-tone="info">
           Esta carteira não tem SOL na <strong>${esc(cluster())}</strong>.
         </div>`
      : ''
  }

  // Tracejado: é um recurso de teste, não uma ação do produto.
  return `
    <div class="mt-3.5 flex items-center gap-3 rounded-caixa border border-dashed border-line px-3.5 py-3">
      <div class="flex-1 text-xs/[1.5] text-text-dim">
        ${
          balance === 0n
            ? `Sem SOL na <strong class="font-mono text-text">${esc(cluster())}</strong>. O SOL de mainnet não aparece aqui — são redes separadas.`
            : 'Precisa de mais SOL de teste?'
        }
      </div>
      <button id="faucet" class="ghost w-auto flex-none px-3.5 py-[9px] text-xs/none" ${busy ? 'disabled' : ''}>
        ${busy && netState.pending === 'faucet' ? '<span class="spinner"></span>Pedindo…' : 'Pedir SOL de teste'}
      </button>
    </div>`
}

/**
 * O lobby, em três colunas.
 *
 * Cada uma responde a uma pergunta diferente, e é isso que justifica a
 * separação:
 *
 *   esquerda  quem eu sou      saldo, retrospecto
 *   meio      o que eu faço    criar mesa, entrar numa
 *   direita   o que já fiz     histórico auditável
 *
 * O meio é o que cresce, porque é onde a ação está. As laterais têm largura
 * fixa: saldo e histórico não ficam melhores esticados. Espremer as três num
 * cartão só transformava a página numa lista comprida sem hierarquia.
 *
 * Em duas colunas o histórico desce para a largura toda — é o conteúdo mais
 * dispensável quando o espaço aperta, ninguém aposta olhando o passado. Os
 * cortes são `max-width`, e não os breakpoints do Tailwind, porque as larguras
 * saem do próprio conteúdo: 1180px é onde as três colunas param de caber.
 */
function renderLobby(): string {
  const rooms = netState.rooms
  const balance = netState.lamports

  return `
    <div class="grid grid-cols-[300px_minmax(0,1fr)_340px] items-start gap-5
                max-[1180px]:grid-cols-[280px_minmax(0,1fr)]
                max-[820px]:grid-cols-1 max-[820px]:gap-4">
      <aside class="min-w-0">
        ${renderCarteira()}
        ${renderRetrospecto()}
        <div class="mt-4 grid gap-2.5">
          <button id="disconnect" class="ghost">Sair</button>
        </div>
      </aside>

      <main class="min-w-0">
        <section class="painel">
          <h2 class="section">Criar mesa</h2>
          <div class="mb-[22px] grid gap-2.5 rounded-caixa border border-line-soft bg-white/[1.5%] p-3.5">
            <!-- Entrada e modalidade na mesma linha porque são as duas decisões
                 da aposta; o nome é opcional e fica embaixo, na largura toda. -->
            <div class="grid grid-cols-2 gap-2">
              <input id="stake" class="m-0" inputmode="decimal" placeholder="Entrada" value="${esc(form.stake)}" />
              <select id="mode" class="select-modo" aria-label="Modalidade">
                ${GAME_MODES.map(
                  (id) =>
                    `<option value="${id}" ${form.mode === id ? 'selected' : ''}>${esc(
                      GAME_MODE_INFO[id].name,
                    )}</option>`,
                ).join('')}
              </select>
              <input id="label" class="col-span-2 m-0" maxlength="24" placeholder="Nome da mesa (opcional)" value="${esc(form.label)}" />
            </div>
            <button id="create" ${busy || balance === 0n ? 'disabled' : ''}>
              ${busy && netState.pending === 'creating' ? '<span class="spinner"></span>Aguardando a Phantom…' : 'Criar mesa e depositar'}
            </button>
          </div>
          <p class="footnote">
            Criar ou entrar numa mesa é uma transação real na ${esc(cluster())}.
            O depósito fica no contrato até a partida terminar.
          </p>
        </section>

        <section class="painel">
          <h2 class="section">Mesas abertas ${rooms.length ? `<span>${rooms.length}</span>` : ''}</h2>
          ${
            rooms.length
              ? `<ul class="rooms">${rooms.map(renderRoomRow).join('')}</ul>`
              : `<p class="empty">Nenhuma mesa aberta. Crie a primeira.</p>`
          }
        </section>
      </main>

      <aside class="min-w-0 max-[1180px]:col-span-full max-[820px]:col-auto">
        <section class="painel">
          <h2 class="section">Suas partidas ${historico.length ? `<span>${historico.length}</span>` : ''}</h2>
          ${
            historicoCarregando
              ? `<p class="empty"><span class="spinner"></span>Lendo da blockchain…</p>`
              : renderHistory(historico, symbol())
          }
          <p class="footnote">
            Lido direto da blockchain. Cada partida é reproduzida aqui no seu
            navegador: o selo confirma que os bytes gravados batem com o hash da
            liquidação e chegam a um vencedor.
          </p>
        </section>
      </aside>
    </div>`
}

function body(): string {
  if (!netState.authenticated) return renderGate()
  if (netState.myRoom) return renderMyRoom(netState.myRoom)
  return renderLobby()
}

function render(): void {
  const error = localError ?? netState.error
  const noLobby = netState.authenticated && netState.address !== null

  // O lobby usa a tela inteira; as telas de entrada continuam num cartão
  // estreito, porque uma coluna de 1100px com dois botões fica pior, não
  // melhor.
  root.className = noLobby ? 'largo' : ''

  // No lobby o topo é uma FAIXA, não um cartão: ele emoldura a página em vez de
  // competir com os painéis por atenção. Nas telas de entrada é o cartão.
  root.innerHTML = `
    ${renderNetworkBar()}
    <main class="${noLobby ? 'block p-1 pb-[22px]' : 'rounded-painel border border-line bg-linear-to-b from-felt-800 to-felt-900 p-7 shadow-[0_24px_60px_rgba(0,0,0,0.45)]'}">
      <header class="flex flex-wrap items-center justify-between gap-5 ${noLobby ? 'mb-0' : 'mb-[22px] max-[560px]:mb-4'}">
        <div class="flex items-center gap-3.5">
          <div class="ball8" aria-hidden="true"></div>
          <div>
            <h1 class="text-[20px] font-bold tracking-[-0.01em]">ZINC Pool</h1>
            <p class="mt-1 text-[13px]/[1.5] text-text-dim">8-Ball 1v1 com aposta em ${esc(symbol())}. Salas com escrow on-chain.</p>
          </div>
        </div>
        ${noLobby ? renderBadges() : ''}
      </header>
      ${error ? `<div class="notice" data-tone="error">${esc(error)}</div>` : ''}
      ${!error && notice ? `<div class="notice" data-tone="ok">${esc(notice)}</div>` : ''}
      ${noLobby ? '' : body()}
    </main>
    ${noLobby ? body() : ''}`

  bind()
}

/**
 * Painel da carteira.
 *
 * O saldo é o número que o jogador confere antes de cada aposta, então vem
 * grande e sempre no mesmo canto — não numa linha de lista entre outras.
 */
function renderCarteira(): string {
  const balance = netState.lamports

  // `tabular-nums`: o saldo muda a cada bloco, e sem largura fixa de dígito ele
  // treme no lugar a cada atualização.
  return `
    <section class="painel grid gap-1">
      <div class="flex items-baseline gap-[7px]">
        <span class="font-sans text-[28px]/none font-bold tabular-nums tracking-[-0.01em] text-chalk">${balance === null ? '—' : formatAmount(balance)}</span>
        <span class="text-[13px] opacity-65">${esc(symbol())}</span>
      </div>
      <a class="font-mono text-xs/none font-medium opacity-60 hover:opacity-100"
         href="${explorerAddressUrl(netState.address!)}"
         target="_blank" rel="noopener">${esc(short(netState.address!))} ↗</a>
      ${renderFaucet()}
    </section>`
}

/**
 * Retrospecto do jogador.
 *
 * Sai do histórico que já foi carregado, então não custa nenhuma leitura
 * extra — e responde a pergunta que todo mundo faz antes de apostar de novo.
 */
function renderRetrospecto(): string {
  if (historicoCarregando) {
    return `<section class="painel"><h2 class="section">Seu retrospecto</h2>
      <p class="empty"><span class="spinner"></span>Lendo da blockchain…</p></section>`
  }
  if (historico.length === 0) return ''

  const vitorias = historico.filter((h) => h.won).length
  const derrotas = historico.length - vitorias
  const aproveitamento = Math.round((vitorias / historico.length) * 100)

  // Saldo: o vencedor leva 90% do pote, então cada vitória rende 90% do pote
  // menos a própria entrada (metade do pote); cada derrota custa a entrada.
  const saldo = historico.reduce((total, h) => {
    const pote = BigInt(h.pot)
    const entrada = pote / 2n
    return total + (h.won ? (pote * 9000n) / 10000n - entrada : -entrada)
  }, 0n)

  const positivo = saldo >= 0n

  const item = (numero: string, rotulo: string) =>
    `<div class="grid gap-0.5 rounded-lg bg-white/3 py-2.5 text-center">
       <span class="font-sans text-[19px]/none font-bold tabular-nums">${numero}</span>
       <span class="text-[11px] opacity-60">${rotulo}</span>
     </div>`

  return `
    <section class="painel">
      <h2 class="section">Seu retrospecto</h2>
      <div class="mb-3.5 grid grid-cols-3 gap-2.5">
        ${item(String(vitorias), 'vitórias')}
        ${item(String(derrotas), 'derrotas')}
        ${item(`${aproveitamento}%`, 'aproveit.')}
      </div>
      <div class="flex items-baseline justify-between rounded-lg bg-white/3 px-3 py-2.5 text-[13px]">
        <span>Saldo em partidas</span>
        <strong class="tabular-nums ${positivo ? 'text-chalk' : 'text-[#e06c5b]'}">${positivo ? '+' : '−'}${formatAmount((positivo ? saldo : -saldo).toString())} ${esc(symbol())}</strong>
      </div>
    </section>`
}

function bind(): void {
  const on = (sel: string, fn: (el: HTMLElement) => void) =>
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener('click', () => fn(el)))

  on('#connect', () => void onConnect())
  on('#signin', () => void run(() => net.signIn()))
  on('#disconnect', () =>
    void run(async () => {
      net.disconnect()
      await wallet.disconnect()
      net.connect()
    }),
  )
  on('#create', () => onCreate())
  on('#faucet', () =>
    void run(async () => {
      await net.requestFaucet()
      notice = 'SOL de teste recebido.'
    }),
  )
  on('.join', (el) => void run(() => net.joinRoom(el.dataset.room!)))
  on('#cancel', (el) => void run(() => net.cancelRoom(el.dataset.room!)))

  const stake = root.querySelector<HTMLInputElement>('#stake')
  stake?.addEventListener('input', () => {
    form.stake = stake.value
  })
  stake?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onCreate()
  })

  const label = root.querySelector<HTMLInputElement>('#label')
  label?.addEventListener('input', () => {
    form.label = label.value
  })

  const mode = root.querySelector<HTMLSelectElement>('#mode')
  mode?.addEventListener('change', () => {
    form.mode = mode.value as GameMode
  })

  updateCountdown()
}

/**
 * Atualiza o contador sem re-renderizar a tela — um innerHTML por segundo
 * destruiria o foco e o conteúdo dos inputs.
 */
function updateCountdown(): void {
  const el = root.querySelector('#countdown')
  const room = netState.myRoom
  if (!el || !room) return
  const left = Math.max(0, room.expiresAt - Date.now())
  const m = Math.floor(left / 60_000)
  const s = Math.floor((left % 60_000) / 1000)
  el.textContent = `${m}:${String(s).padStart(2, '0')}`
}

setInterval(updateCountdown, 1000)

export function mount(): void {
  wallet.subscribe((state) => {
    const previous = walletState
    walletState = state

    // Trocar de conta na Phantom invalida a sessão: a identidade mudou.
    if (
      previous.status === 'connected' &&
      state.status === 'connected' &&
      !previous.publicKey.equals(state.publicKey)
    ) {
      net.disconnect()
      net.connect()
    }
    render()
  })

  net.subscribe((state) => {
    netState = state
    if (state.error) localError = null
    // Carrega o histórico na primeira vez que a carteira aparece, e de novo se
    // ela mudar. Recarregar a cada mensagem deixaria o lobby lento à toa.
    sincronizarHistorico(state.address)
    render()
  })

  void wallet.autoConnect()
  net.connect()
}
