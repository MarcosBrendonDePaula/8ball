import type { FrameContext } from './entity'
import { Input } from './input'
import type { Scene } from './scene'
import { Time } from './time'
import { Viewport } from './viewport'

/**
 * Laço do jogo com passo fixo e render interpolado.
 *
 * O padrão é o mesmo da Unity, e a razão de ser é a mesma: a física precisa
 * andar em passos constantes, mas o desenho deve acompanhar a taxa de quadros
 * do monitor. Amarrar os dois faria a simulação depender do hardware — e num
 * jogo em que os dois jogadores precisam ver exatamente a mesma partida, isso
 * é inaceitável.
 *
 * A sequência de cada quadro:
 *
 *   1. mede o tempo real decorrido (limitado, para aba em segundo plano)
 *   2. roda N passos fixos de física
 *   3. roda um update de lógica e entrada
 *   4. desenha, interpolando pela fração de passo restante
 */
export class GameLoop {
  readonly time: Time
  readonly input: Input
  readonly viewport: Viewport

  #canvas: HTMLCanvasElement
  #ctx: CanvasRenderingContext2D
  #scene: Scene
  #frameId: number | null = null
  #lastTimestamp = 0
  #running = false
  #observador: ResizeObserver | null = null

  /**
   * Teto do delta de um quadro.
   *
   * Volta de aba em segundo plano pode trazer minutos acumulados; sem limite,
   * o laço tentaria simular tudo de uma vez e travaria a página.
   */
  static readonly MAX_FRAME_DELTA = 0.25

  constructor(canvas: HTMLCanvasElement, scene: Scene, fixedDeltaTime: number) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D indisponível neste navegador.')

    this.#canvas = canvas
    this.#ctx = ctx
    this.#scene = scene

    this.time = new Time(fixedDeltaTime)
    this.input = new Input(canvas)
    this.viewport = new Viewport(canvas.width, canvas.height)

    this.#watchResize()
  }

  get context(): FrameContext {
    return { time: this.time, input: this.input, viewport: this.viewport, ctx: this.#ctx }
  }

  start(): void {
    if (this.#running) return
    this.#running = true

    this.#scene.begin(this.context)
    this.#lastTimestamp = performance.now()
    this.#frameId = requestAnimationFrame(this.#frame)
  }

  stop(): void {
    this.#running = false
    if (this.#frameId !== null) cancelAnimationFrame(this.#frameId)
    this.#frameId = null
  }

  dispose(): void {
    this.stop()
    this.input.dispose()
    this.#observador?.disconnect()
    this.#scene.destroy()
  }

  #frame = (timestamp: number): void => {
    if (!this.#running) return

    const bruto = (timestamp - this.#lastTimestamp) / 1000
    this.#lastTimestamp = timestamp

    const delta = Math.min(bruto, GameLoop.MAX_FRAME_DELTA)
    const contexto = this.context

    const passos = this.time.advance(delta)
    for (let i = 0; i < passos; i++) this.#scene.fixedUpdate(contexto)

    this.#scene.update(contexto)
    this.#scene.render(contexto)

    // No fim do quadro, não no começo: um evento que chega entre o update e o
    // render ainda precisa ser visto no quadro seguinte.
    this.input.endFrame()

    this.#frameId = requestAnimationFrame(this.#frame)
  }

  /**
   * Mantém o canvas na resolução física da tela.
   *
   * Sem considerar o `devicePixelRatio`, a mesa fica borrada em tela retina —
   * e numa mesa de sinuca, borrado é mira imprecisa.
   */
  #watchResize(): void {
    const ajustar = () => {
      const caixa = this.#canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)

      const largura = Math.max(1, Math.round(caixa.width * dpr))
      const altura = Math.max(1, Math.round(caixa.height * dpr))

      if (this.#canvas.width !== largura || this.#canvas.height !== altura) {
        this.#canvas.width = largura
        this.#canvas.height = altura
      }
      this.viewport.resize(largura, altura)
    }

    ajustar()
    this.#observador = new ResizeObserver(ajustar)
    this.#observador.observe(this.#canvas)
  }
}
