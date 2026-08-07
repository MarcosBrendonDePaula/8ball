import '@/polyfills'
import '@/styles.css'
import './play.css'

import { createPoolScene, type PoolSceneHandle } from './PoolScene'
import { connectMatch, type NetMatchState } from './NetworkedMatch'
import { GameClient } from '@/net/client'
import { PhantomWallet, getProvider } from '@/wallet/phantom'
import { GAME_MODE_INFO } from '@zinc-pool/engine-rules'

/**
 * Mesa apostada, contra outra pessoa.
 *
 * Diferente da hotseat em `main.ts` numa coisa só, mas que muda tudo: quem
 * decide o resultado é o servidor. Esta tela prevê a tacada localmente para
 * não esperar a rede, e confere o hash que volta — a física é determinística,
 * então a previsão é exata e não há rollback a fazer.
 *
 * A mesa só aparece depois do `match.start`, porque antes disso o seed da
 * quebra não existe. Armar um triângulo antes seria montar uma mesa que o
 * servidor não reconheceria.
 */

const app = document.getElementById('app')!

if (!getProvider()) {
  app.innerHTML = `<div class="net-aviso">
    <h1>Phantom não encontrada</h1>
    <p>Instale a carteira e recarregue para jogar uma mesa apostada.</p>
    <p><a href="/">Voltar ao lobby</a></p>
  </div>`
  throw new Error('sem carteira')
}

// A tela é montada ANTES de conectar: `match.start` pode chegar a qualquer
// momento e precisa encontrar o canvas pronto.
app.innerHTML = `
  <header class="play-header">
    <a class="play-voltar" href="/">← Lobby</a>
    <div class="net-status" id="status">conectando…</div>
    <button class="net-desistir" id="desistir" hidden>Desistir</button>
  </header>
  <div class="play-mesa"><canvas id="mesa"></canvas></div>
  <div class="net-painel" id="painel"></div>
`

const status = document.getElementById('status')!
const painel = document.getElementById('painel')!
const desistir = document.getElementById('desistir') as HTMLButtonElement

const client = new GameClient(new PhantomWallet())
let cena: PoolSceneHandle | null = null

const partida = connectMatch(client, (mode, seed) => {
  const canvas = document.getElementById('mesa') as HTMLCanvasElement
  cena = createPoolScene(canvas, mode, seed)
  return cena.match
})

client.connect()

desistir.onclick = () => {
  // Desistir entrega o pote ao adversário e é irreversível. Confirmar aqui é
  // barato; um clique acidental custa a mesa inteira.
  if (confirm('Desistir entrega o pote ao adversário. Confirma?')) client.forfeit()
}

partida.subscribe((s) => {
  status.textContent = descreverFase(s)
  desistir.hidden = s.fase !== 'jogando'
  painel.innerHTML = montarPainel(s)

  for (const botao of painel.querySelectorAll<HTMLButtonElement>('[data-opcao]')) {
    botao.onclick = () => client.decide(Number(botao.dataset.opcao))
  }
})

/**
 * Relógio da vez.
 *
 * Redesenhado por quadro em vez de por mensagem: o prazo é contínuo, e mostrar
 * só o instante em que ele chegou faria o jogador achar que tem mais tempo do
 * que tem.
 */
setInterval(() => {
  const s = partida.state
  const alvo = document.getElementById('relogio')
  if (!alvo || s.deadline === null) return

  const restante = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000))
  alvo.textContent = `${restante}s`
  alvo.classList.toggle('urgente', restante <= 10)
}, 200)

function descreverFase(s: NetMatchState): string {
  if (s.desync) return `⚠ ${s.desync}`
  if (s.opponentOffline) return 'Adversário fora — a vez dele passa sozinha'

  switch (s.fase) {
    case 'aguardando':
      return 'Aguardando uma mesa fechar no lobby…'
    case 'comprometendo':
      return 'Combinando a quebra…'
    case 'revelando':
      return 'Revelando a quebra…'
    case 'jogando':
      return s.turn === s.you ? 'Sua vez' : 'Vez do adversário'
    case 'terminada':
      return s.resultado?.winner === s.you ? 'Você venceu' : 'Você perdeu'
  }
}

function montarPainel(s: NetMatchState): string {
  if (s.desync) {
    // Divergir significa que a nossa mesa deixou de representar a partida.
    // Continuar desenhando seria mentir para o jogador.
    return `<div class="net-erro">
      <strong>A mesa saiu de sincronia com o servidor.</strong>
      <p>O resultado da partida continua correto e será liquidado normalmente.
         Recarregue para reacompanhar.</p>
    </div>`
  }

  if (s.fase === 'terminada' && s.resultado) {
    const venceu = s.resultado.winner === s.you
    return `<div class="net-fim ${venceu ? 'venceu' : 'perdeu'}">
      <strong>${venceu ? 'Você venceu' : s.resultado.winner === null ? 'Partida anulada' : 'Você perdeu'}</strong>
      <span>por ${s.resultado.reason}</span>
      <p>${
        s.resultado.winner === null
          ? 'As entradas voltam para os dois pelo contrato.'
          : 'O pagamento e o replay vão para a blockchain automaticamente.'
      }</p>
      <a href="/">Voltar ao lobby</a>
    </div>`
  }

  if (s.decision) {
    const minha = s.decision.chooser === s.you
    if (!minha) return `<div class="net-espera">Adversário está escolhendo…</div>`

    return `<div class="net-decisao">
      <strong>Sua escolha</strong>
      ${s.decision.options
        .map((o, i) => `<button data-opcao="${i}">${o}</button>`)
        .join('')}
    </div>`
  }

  if (s.fase !== 'jogando') return ''

  return `<div class="net-vez">
    <span>${GAME_MODE_INFO[s.mode].name}</span>
    <span id="relogio">—</span>
    <span>${s.mensagem ?? ''}</span>
  </div>`
}
