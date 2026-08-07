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
      <strong>${esc(rotulo)}</strong>
      <span class="netbar-text">${esc(explicacao)}</span>
    </div>`
}

function renderBadges(): string {
  const online = netState.connection === 'online'
  const conn = online ? 'conectado' : netState.connection === 'connecting' ? 'conectando…' : 'offline'
  const programa = netState.limits?.programId
  return `
    <div class="badges">
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
    <div class="actions">
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

  return `
    ${renderBadges()}
    <div class="notice" data-tone="info">
      ${
        waiting
          ? `Sua mesa está aberta e o depósito está travado no contrato. Sai da lista em <span id="countdown">…</span> se ninguém entrar — o dinheiro continua seu, basta cancelar.`
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

    <div class="actions">
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
    </p>`
}

function renderRoomRow(room: Room): string {
  return `
    <li class="room">
      <div class="room-main">
        <span class="room-label">${esc(room.label)}</span>
        <span class="room-host">${esc(GAME_MODE_INFO[room.mode].name)} · ${esc(short(room.creator))}</span>
      </div>
      <div class="room-side">
        <span class="room-stake">${formatAmount(room.stake)} ${esc(symbol())}</span>
        <button class="join" ${busy ? 'disabled' : ''} data-room="${room.id}">Entrar</button>
      </div>
    </li>`
}

function renderLobby(): string {
  const rooms = netState.rooms
  const balance = netState.lamports

  return `
    ${renderBadges()}

    <dl class="rows">
      <div class="row">
        <dt>Carteira</dt>
        <dd><a href="${explorerAddressUrl(netState.address!)}" target="_blank" rel="noopener">${esc(short(netState.address!))}</a></dd>
      </div>
      <div class="row">
        <dt>Saldo</dt>
        <dd><strong>${balance === null ? '—' : formatAmount(balance)} ${esc(symbol())}</strong></dd>
      </div>
    </dl>

    ${
      netState.limits?.faucetAvailable
        ? `<div class="faucet">
             <div class="faucet-text">
               ${
                 balance === 0n
                   ? `Sem SOL na <strong>${esc(cluster())}</strong>. O SOL de mainnet não aparece aqui — são redes separadas.`
                   : 'Precisa de mais SOL de teste?'
               }
             </div>
             <button id="faucet" class="ghost" ${busy ? 'disabled' : ''}>
               ${busy && netState.pending === 'faucet' ? '<span class="spinner"></span>Pedindo…' : 'Pedir SOL de teste'}
             </button>
           </div>`
        : balance === 0n
          ? `<div class="notice" data-tone="info">
               Esta carteira não tem SOL na <strong>${esc(cluster())}</strong>.
             </div>`
          : ''
    }

    <div class="create">
      <div class="create-fields">
        <input id="stake" inputmode="decimal" placeholder="Entrada" value="${esc(form.stake)}" />
        <input id="label" maxlength="24" placeholder="Nome da mesa (opcional)" value="${esc(form.label)}" />
        <select id="mode" aria-label="Modalidade">
          ${GAME_MODES.map(
            (id) =>
              `<option value="${id}" ${form.mode === id ? 'selected' : ''}>${esc(
                GAME_MODE_INFO[id].name,
              )}</option>`,
          ).join('')}
        </select>
      </div>
      <button id="create" ${busy || balance === 0n ? 'disabled' : ''}>
        ${busy && netState.pending === 'creating' ? '<span class="spinner"></span>Aguardando a Phantom…' : 'Criar mesa e depositar'}
      </button>
    </div>

    <h2 class="section">Mesas abertas ${rooms.length ? `<span>${rooms.length}</span>` : ''}</h2>
    ${
      rooms.length
        ? `<ul class="rooms">${rooms.map(renderRoomRow).join('')}</ul>`
        : `<p class="empty">Nenhuma mesa aberta. Crie a primeira.</p>`
    }

    <h2 class="section">Suas partidas ${historico.length ? `<span>${historico.length}</span>` : ''}</h2>
    ${
      historicoCarregando
        ? `<p class="empty"><span class="spinner"></span>Lendo da blockchain…</p>`
        : renderHistory(historico, symbol())
    }

    <div class="actions">
      <button id="disconnect" class="ghost">Sair</button>
    </div>
    <p class="footnote">
      Criar ou entrar numa mesa é uma transação real na ${esc(cluster())}. A Phantom
      pede aprovação e o depósito fica no contrato até a partida terminar.
    </p>`
}

function body(): string {
  if (!netState.authenticated) return renderGate()
  if (netState.myRoom) return renderMyRoom(netState.myRoom)
  return renderLobby()
}

function render(): void {
  const error = localError ?? netState.error

  root.innerHTML = `
    ${renderNetworkBar()}
    <main class="card">
      <div class="brand">
        <div class="ball8" aria-hidden="true"></div>
        <h1>ZINC Pool</h1>
      </div>
      <p class="subtitle">8-Ball 1v1 com aposta em ${esc(symbol())}. Salas com escrow on-chain.</p>
      ${error ? `<div class="notice" data-tone="error">${esc(error)}</div>` : ''}
      ${!error && notice ? `<div class="notice" data-tone="ok">${esc(notice)}</div>` : ''}
      ${body()}
    </main>`

  bind()
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
