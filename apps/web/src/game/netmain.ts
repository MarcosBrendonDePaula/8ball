import '@/polyfills'
import '@/styles.css'
import './play.css'

import { createPoolScene, type PoolSceneHandle } from './PoolScene'
import { connectMatch, type NetMatchState } from './NetworkedMatch'
import { GameClient } from '@/net/client'
import { PhantomWallet, getProvider } from '@/wallet/phantom'
import { explorerTxUrl } from '@/config'
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

/** Caixa dos avisos da mesa: destaca do feltro sem virar um cartão. */
const CAIXA = 'rounded-caixa bg-black/35 px-5 py-4'

/** Os `<p>` perdem a margem do navegador no reset; aqui ela volta explícita. */
const PARAGRAFO = 'my-4'

if (!getProvider()) {
  app.innerHTML = `<div class="${CAIXA}">
    <h1 class="text-[20px] font-bold tracking-[-0.01em]">Phantom não encontrada</h1>
    <p class="${PARAGRAFO}">Instale a carteira e recarregue para jogar uma mesa apostada.</p>
    <p class="${PARAGRAFO}"><a href="/">Voltar ao lobby</a></p>
  </div>`
  throw new Error('sem carteira')
}

// A tela é montada ANTES de conectar: `match.start` pode chegar a qualquer
// momento e precisa encontrar o canvas pronto.
app.innerHTML = `
  <header class="play-header">
    <a href="/">← Lobby</a>
    <div class="tabular-nums opacity-90" id="status">conectando…</div>
    <!-- Sem largura própria: herda o w-full da regra de button e, por não caber
         ao lado do status, quebra para uma linha inteira — como já fazia. -->
    <button class="ml-auto cursor-pointer rounded-md border border-white/25
                   bg-none bg-transparent px-[0.8rem] py-[0.35rem] text-inherit
                   hover:border-[#e06c5b] hover:text-[#e06c5b]"
            id="desistir" hidden>Desistir</button>
  </header>
  <div class="play-mesa"><canvas id="mesa"></canvas></div>
  <div class="flex justify-center px-4 pb-4" id="painel"></div>
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

  for (const botao of painel.querySelectorAll<HTMLButtonElement>('[data-cacapa]')) {
    botao.onclick = () => {
      // A escolha fica no controlador: é ela que libera a mira e viaja junto
      // da tacada. Mandar numa mensagem separada deixaria o jogador declarar
      // depois de ver o resultado.
      if (cena) cena.match.calledPocket = Number(botao.dataset.cacapa)
      painel.innerHTML = montarPainel(partida.state)
    }
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
  alvo.classList.toggle('text-[#e06c5b]', restante <= 10)
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
    return `<div class="${CAIXA}">
      <strong class="text-[#e0b95b]">A mesa saiu de sincronia com o servidor.</strong>
      <p class="${PARAGRAFO}">O resultado da partida continua correto e será liquidado normalmente.
         Recarregue para reacompanhar.</p>
    </div>`
  }

  if (s.fase === 'terminada' && s.resultado) {
    const venceu = s.resultado.winner === s.you
    return `<div class="${CAIXA} grid gap-[0.4rem] text-center">
      <strong class="${venceu ? 'text-[#6fcf8b]' : 'text-[#e06c5b]'}">${venceu ? 'Você venceu' : s.resultado.winner === null ? 'Partida anulada' : 'Você perdeu'}</strong>
      <span>por ${s.resultado.reason}</span>
      ${liquidacao(s)}
      <a href="/">Voltar ao lobby</a>
    </div>`
  }

  // Declarar a caçapa vem antes de tudo: sem isso a mira nem aparece, e
  // encaçapar a bola 8 sem declarar é DERROTA pela regra da WPA.
  if (s.callRequired && s.turn === s.you && cena && cena.match.calledPocket === null) {
    return `<div class="${DECISAO}">
      <strong>Declare a caçapa da bola 8</strong>
      ${CACAPAS.map((nome, i) => `<button class="${BOTAO_DECISAO}" data-cacapa="${i}">${nome}</button>`).join('')}
    </div>`
  }

  if (s.callRequired && s.turn !== s.you) {
    return `<div class="${CAIXA}">Adversário está na bola 8…</div>`
  }

  if (s.decision) {
    const minha = s.decision.chooser === s.you
    if (!minha) return `<div class="${CAIXA}">Adversário está escolhendo…</div>`

    return `<div class="${DECISAO}">
      <strong>Sua escolha</strong>
      ${s.decision.options
        .map((o, i) => `<button class="${BOTAO_DECISAO}" data-opcao="${i}">${o}</button>`)
        .join('')}
    </div>`
  }

  if (s.fase !== 'jogando') return ''

  // O relógio é o único elemento que muda de cor: é a informação que o jogador
  // precisa perceber sem estar olhando para ela. A classe `urgente` entra pelo
  // laço abaixo, por isso ela não pode ser condicional aqui.
  return `<div class="flex items-baseline gap-5 tabular-nums">
    <span>${GAME_MODE_INFO[s.mode].name}</span>
    <span class="text-[1.4rem] font-semibold" id="relogio">—</span>
    <span>${s.mensagem ?? ''}</span>
  </div>`
}

const DECISAO = `${CAIXA} flex flex-wrap items-center gap-[0.6rem]`

/* Sem largura própria de propósito: os botões herdam o `w-full` da regra de
   `button` e, num flex que encolhe, dividem a linha em partes iguais. */
const BOTAO_DECISAO =
  'cursor-pointer rounded-md border border-white/30 bg-none bg-transparent ' +
  'px-[0.9rem] py-[0.4rem] text-inherit hover:border-[#6fcf8b] hover:text-[#6fcf8b]'

/**
 * Nomes das caçapas, na ordem do motor.
 *
 * A ORDEM é a de `POCKETS` em `table.ts` e é parte do formato do replay: o
 * índice é o que fica gravado. Trocar a ordem faria replays antigos apontarem
 * outra caçapa declarada.
 */
const CACAPAS = [
  'Inferior esquerda',
  'Inferior meio',
  'Inferior direita',
  'Superior esquerda',
  'Superior meio',
  'Superior direita',
]

/**
 * Estado da liquidação, com o link para conferir.
 *
 * "Vai para a blockchain automaticamente" é uma promessa que o jogador não tem
 * como verificar sozinho. Com a assinatura, ele confere o pagamento no
 * explorer sem depender da nossa palavra — que é o ponto do escrow on-chain.
 */
function liquidacao(s: NetMatchState): string {
  if (s.resultado?.winner === null) {
    return `<p class="${PARAGRAFO}">As entradas voltam para os dois pelo contrato.</p>`
  }

  if (!s.liquidacao) {
    return `<p class="${PARAGRAFO}"><span class="spinner"></span>Enviando o pagamento e o replay para a blockchain…</p>`
  }

  if (s.liquidacao.signature) {
    return `<p class="${PARAGRAFO}">Pagamento e replay gravados.
      <a href="${explorerTxUrl(s.liquidacao.signature)}" target="_blank" rel="noopener">
        ver a transação ↗
      </a></p>`
  }

  // O aviso de falha na liquidação precisa ser lido, mas não pode parecer que o
  // jogador perdeu o dinheiro — ele volta pelo contrato.
  return `<p class="${PARAGRAFO} text-[0.9em] text-[#e0b95b]">Não foi possível liquidar agora
    (${s.liquidacao.reason ?? 'motivo desconhecido'}).
    As entradas voltam pelo prazo do contrato.</p>`
}
