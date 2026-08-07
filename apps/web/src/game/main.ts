import '@/polyfills'
import '@/styles.css'
import './play.css'

import { createPoolScene, type PoolSceneHandle } from './PoolScene'
import { GAME_MODES, GAME_MODE_INFO, isGameModeId, type GameModeId } from '@zinc-pool/engine-rules'

/**
 * Mesa jogável em hotseat — os dois jogadores no mesmo navegador.
 *
 * Sem rede e sem dinheiro de propósito. É aqui que se descobre se o jogo é
 * divertido, e essa resposta precisa vir antes de amarrar aposta nele.
 */

const app = document.getElementById('app')!

const parametros = new URLSearchParams(location.search)
const modoInicial: GameModeId =
  isGameModeId(parametros.get('modo') ?? '') ? (parametros.get('modo') as GameModeId) : 'eightball'

let cena: PoolSceneHandle | null = null

function montar(modo: GameModeId, seed = 1): void {
  cena?.dispose()

  app.innerHTML = `
    <header class="play-header">
      <div class="play-modos">
        ${GAME_MODES.map(
          (id) => `
          <button class="modo ${id === modo ? 'ativo' : ''}" data-modo="${id}">
            ${GAME_MODE_INFO[id].name}
          </button>`,
        ).join('')}
      </div>
      <div class="play-acoes">
        <button id="reiniciar" class="ghost">Nova partida</button>
        <a class="ghost" href="/">Voltar</a>
      </div>
    </header>

    <p class="play-descricao">${GAME_MODE_INFO[modo].description}</p>

    <div class="play-mesa">
      <canvas id="mesa"></canvas>
    </div>`

  const canvas = document.getElementById('mesa') as HTMLCanvasElement
  cena = createPoolScene(canvas, modo, seed)

  app.querySelectorAll<HTMLElement>('.modo').forEach((botao) => {
    botao.addEventListener('click', () => {
      const alvo = botao.dataset.modo
      if (isGameModeId(alvo ?? '')) montar(alvo as GameModeId)
    })
  })

  document.getElementById('reiniciar')?.addEventListener('click', () => {
    // Seed diferente muda o jitter da quebra, então a mesa nunca abre igual.
    montar(modo, (seed % 250) + 3)
  })
}

montar(modoInicial)
