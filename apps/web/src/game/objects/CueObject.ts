import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from './MatchController'

/**
 * Mira e tacada.
 *
 * O gesto: arrastar A PARTIR da branca, no sentido oposto ao alvo — como puxar
 * o taco para trás. Soltar dispara. É o gesto que os jogos de sinuca no
 * celular consolidaram, e ele resolve mira e força no mesmo movimento.
 *
 * Nenhuma projeção de trajetória: mostrar onde a bola vai parar daria ao
 * jogador uma vantagem que ele não tem numa mesa de verdade, e transformaria
 * habilidade em leitura de linha pontilhada.
 */

/** Arraste máximo, em pixels, que corresponde a força total. */
const ARRASTE_MAXIMO = 220

/** Abaixo disto o gesto é considerado toque acidental, não tacada. */
const ARRASTE_MINIMO = 12

export class CueObject extends Entity {
  /** Ângulo atual da mira, em radianos. */
  angle = 0

  /** Força de 0 a 1. */
  power = 0

  /** Mirando neste momento. */
  aiming = false

  constructor(private readonly match: MatchController) {
    super('Cue')
    this.order = 20 // acima das bolas
  }

  override update({ input, viewport }: FrameContext): void {
    if (!this.match.canShoot) {
      this.aiming = false
      this.power = 0
      return
    }

    const branca = this.match.cueBall
    if (!branca) return

    if (input.pressedThisFrame) this.aiming = true

    if (this.aiming && input.isDown) {
      const brancaTela = viewport.toScreen(
        this.match.interpolated(branca, 1).x,
        this.match.interpolated(branca, 1).y,
      )

      // Vetor do ponteiro para a branca: mira no sentido oposto ao arraste.
      const dx = brancaTela.x - input.position.x
      const dy = brancaTela.y - input.position.y

      const distancia = Math.hypot(dx, dy)
      if (distancia > 1) {
        // Y invertido na conversão para o mundo.
        this.angle = Math.atan2(-dy, dx)
        this.power = Math.min(1, Math.max(0, (distancia - ARRASTE_MINIMO) / ARRASTE_MAXIMO))
      }
    }

    if (this.aiming && input.releasedThisFrame) {
      this.aiming = false
      if (this.power > 0.02) {
        this.match.shoot(this.angle, this.power)
      }
      this.power = 0
    }
  }

  override render({ ctx, viewport, time }: FrameContext): void {
    if (!this.match.canShoot) return

    const branca = this.match.cueBall
    if (!branca || branca.pocketed) return

    const mundo = this.match.interpolated(branca, time.alpha)
    const origem = viewport.toScreen(mundo.x, mundo.y)
    const raio = viewport.ballRadiusPx

    this.#linhaDeMira(ctx, origem, raio, viewport.scale)
    if (this.aiming) this.#taco(ctx, origem, raio)
  }

  /** Linha tracejada na direção da tacada. */
  #linhaDeMira(
    ctx: CanvasRenderingContext2D,
    origem: { x: number; y: number },
    raio: number,
    escala: number,
  ): void {
    const comprimento = raio * 2.5 + this.power * escala * 0.5

    const fim = {
      x: origem.x + Math.cos(this.angle) * comprimento,
      y: origem.y - Math.sin(this.angle) * comprimento,
    }

    ctx.strokeStyle = this.aiming ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([7, 6])
    ctx.beginPath()
    ctx.moveTo(origem.x + Math.cos(this.angle) * raio, origem.y - Math.sin(this.angle) * raio)
    ctx.lineTo(fim.x, fim.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** Taco atrás da branca, recuado conforme a força. */
  #taco(ctx: CanvasRenderingContext2D, origem: { x: number; y: number }, raio: number): void {
    const recuo = raio * 1.4 + this.power * raio * 6
    const comprimento = raio * 14

    const dx = -Math.cos(this.angle)
    const dy = Math.sin(this.angle)

    const inicio = { x: origem.x + dx * recuo, y: origem.y + dy * recuo }
    const fim = { x: inicio.x + dx * comprimento, y: inicio.y + dy * comprimento }

    const madeira = ctx.createLinearGradient(inicio.x, inicio.y, fim.x, fim.y)
    madeira.addColorStop(0, '#e8d7b8')
    madeira.addColorStop(0.12, '#b98a4e')
    madeira.addColorStop(1, '#4a3a22')

    ctx.strokeStyle = madeira
    ctx.lineWidth = Math.max(3, raio * 0.42)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(inicio.x, inicio.y)
    ctx.lineTo(fim.x, fim.y)
    ctx.stroke()
  }
}
