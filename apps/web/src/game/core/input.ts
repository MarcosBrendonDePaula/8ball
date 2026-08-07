/**
 * Entrada de mouse e toque, no espírito do `Input` da Unity.
 *
 * Guarda ESTADO em vez de disparar callbacks. A cena pergunta "o botão está
 * pressionado?" durante o update, em vez de reagir a eventos em qualquer
 * momento — isso mantém toda a lógica dentro do laço, onde a ordem é
 * previsível.
 *
 * Mouse e toque entram pelo mesmo caminho: um jogo de sinuca precisa funcionar
 * no celular, e tratar os dois separados dobraria os caminhos de código.
 */
export type Pointer = { x: number; y: number }

export class Input {
  /** Posição atual, em pixels do canvas. */
  readonly position: Pointer = { x: 0, y: 0 }

  /** Onde o arraste começou. */
  readonly pressStart: Pointer = { x: 0, y: 0 }

  /** Pressionado agora. */
  isDown = false

  /** Pressionou NESTE quadro. Consumido por `endFrame`. */
  pressedThisFrame = false

  /** Soltou NESTE quadro. */
  releasedThisFrame = false

  #canvas: HTMLCanvasElement
  #descartar: Array<() => void> = []

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
    this.#bind()
  }

  /** Deslocamento do arraste em curso. */
  get dragDelta(): Pointer {
    return { x: this.position.x - this.pressStart.x, y: this.position.y - this.pressStart.y }
  }

  /**
   * Zera os sinais de "aconteceu neste quadro".
   *
   * Chamado pelo laço no FIM do quadro. Se fosse no início, um evento chegado
   * entre o update e o render seria perdido.
   */
  endFrame(): void {
    this.pressedThisFrame = false
    this.releasedThisFrame = false
  }

  dispose(): void {
    for (const remover of this.#descartar) remover()
    this.#descartar = []
  }

  // ------------------------------------------------------------- interno

  #bind(): void {
    const posicaoDe = (evento: MouseEvent | Touch): Pointer => {
      const caixa = this.#canvas.getBoundingClientRect()
      // Converte para coordenadas do canvas: CSS e resolução interna podem
      // divergir por causa do devicePixelRatio.
      return {
        x: ((evento.clientX - caixa.left) / caixa.width) * this.#canvas.width,
        y: ((evento.clientY - caixa.top) / caixa.height) * this.#canvas.height,
      }
    }

    const pressionar = (p: Pointer) => {
      this.position.x = p.x
      this.position.y = p.y
      this.pressStart.x = p.x
      this.pressStart.y = p.y
      this.isDown = true
      this.pressedThisFrame = true
    }

    const mover = (p: Pointer) => {
      this.position.x = p.x
      this.position.y = p.y
    }

    const soltar = () => {
      if (!this.isDown) return
      this.isDown = false
      this.releasedThisFrame = true
    }

    const on = <K extends keyof HTMLElementEventMap>(
      alvo: HTMLElement | Window,
      tipo: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      opcoes?: AddEventListenerOptions,
    ) => {
      alvo.addEventListener(tipo, handler as EventListener, opcoes)
      this.#descartar.push(() => alvo.removeEventListener(tipo, handler as EventListener))
    }

    on(this.#canvas, 'mousedown', (e) => pressionar(posicaoDe(e)))
    on(this.#canvas, 'mousemove', (e) => mover(posicaoDe(e)))
    // No window, não no canvas: soltar o botão fora da mesa precisa contar.
    on(window as unknown as HTMLElement, 'mouseup', () => soltar())

    on(
      this.#canvas,
      'touchstart',
      (e) => {
        const toque = (e as TouchEvent).touches[0]
        if (toque) pressionar(posicaoDe(toque))
        e.preventDefault()
      },
      { passive: false },
    )
    on(
      this.#canvas,
      'touchmove',
      (e) => {
        const toque = (e as TouchEvent).touches[0]
        if (toque) mover(posicaoDe(toque))
        e.preventDefault()
      },
      { passive: false },
    )
    on(this.#canvas, 'touchend', () => soltar())
    on(this.#canvas, 'touchcancel', () => soltar())
  }
}
