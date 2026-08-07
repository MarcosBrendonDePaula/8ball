import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from './MatchController'
import type { Ball } from '@zinc-pool/engine-physics'

/**
 * Desenho das bolas.
 *
 * Lê a posição INTERPOLADA do controlador, nunca a do último passo físico.
 * A física anda em degraus de 1/240s e o monitor desenha quando quer; sem
 * interpolar, o movimento treme mesmo com a simulação perfeita.
 */

/** Cores do 8-Ball. Lisas 1-7, a 8 preta, listradas 9-15 repetem as cores. */
const CORES_8BALL: Record<number, string> = {
  1: '#f2c14e',
  2: '#2f6fd0',
  3: '#d0392f',
  4: '#7b4bb7',
  5: '#e0762c',
  6: '#2f9e5e',
  7: '#8c2f3f',
  8: '#141414',
  9: '#f2c14e',
  10: '#2f6fd0',
  11: '#d0392f',
  12: '#7b4bb7',
  13: '#e0762c',
  14: '#2f9e5e',
  15: '#8c2f3f',
}

/** Cores da sinuca brasileira, na ordem de valor. */
const CORES_SINUCA: Record<number, string> = {
  1: '#d0392f',
  2: '#f2c14e',
  3: '#2f9e5e',
  4: '#8a5a2b',
  5: '#2f6fd0',
  6: '#e07fa8',
  7: '#141414',
}

export class BallsObject extends Entity {
  constructor(private readonly match: MatchController) {
    super('Balls')
    this.order = 10 // depois da mesa
  }

  override render({ ctx, viewport, time }: FrameContext): void {
    const sinuca = this.match.modeId === 'sinuca'

    for (const bola of this.match.table.balls) {
      if (bola.pocketed) continue

      const mundo = this.match.interpolated(bola, time.alpha)
      const p = viewport.toScreen(mundo.x, mundo.y)
      const raio = viewport.ballRadiusPx

      this.#desenhar(ctx, bola, p, raio, sinuca)
    }
  }

  #desenhar(
    ctx: CanvasRenderingContext2D,
    bola: Ball,
    p: { x: number; y: number },
    raio: number,
    sinuca: boolean,
  ): void {
    const cor =
      bola.id === 0
        ? '#f5f2ea'
        : sinuca
          ? (CORES_SINUCA[bola.id] ?? '#888')
          : (CORES_8BALL[bola.id] ?? '#888')

    // Sombra projetada: dá volume sem precisar de 3D.
    ctx.fillStyle = 'rgba(0,0,0,0.32)'
    ctx.beginPath()
    ctx.arc(p.x + raio * 0.16, p.y + raio * 0.22, raio, 0, Math.PI * 2)
    ctx.fill()

    const brilho = ctx.createRadialGradient(
      p.x - raio * 0.35,
      p.y - raio * 0.35,
      raio * 0.08,
      p.x,
      p.y,
      raio,
    )
    brilho.addColorStop(0, clarear(cor, 80))
    brilho.addColorStop(0.6, cor)
    brilho.addColorStop(1, escurecer(cor, 35))

    ctx.fillStyle = brilho
    ctx.beginPath()
    ctx.arc(p.x, p.y, raio, 0, Math.PI * 2)
    ctx.fill()

    // Faixa das listradas do 8-Ball.
    if (!sinuca && bola.id >= 9) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(p.x, p.y, raio, 0, Math.PI * 2)
      ctx.clip()
      ctx.fillStyle = '#f5f2ea'
      ctx.fillRect(p.x - raio, p.y - raio, raio * 2, raio * 0.5)
      ctx.fillRect(p.x - raio, p.y + raio * 0.5, raio * 2, raio * 0.5)
      ctx.restore()
    }

    // Número só quando cabe legível — abaixo disso vira sujeira visual.
    if (bola.id > 0 && raio >= 9) {
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(p.x, p.y, raio * 0.46, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#111'
      ctx.font = `600 ${Math.round(raio * 0.68)}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(bola.id), p.x, p.y + raio * 0.04)
    }
  }
}

const ajustar = (hex: string, delta: number): string => {
  const n = Number.parseInt(hex.slice(1), 16)
  const canal = (deslocamento: number) =>
    Math.max(0, Math.min(255, ((n >> deslocamento) & 0xff) + delta))
  return `rgb(${canal(16)},${canal(8)},${canal(0)})`
}

const clarear = (hex: string, delta: number) => ajustar(hex, delta)
const escurecer = (hex: string, delta: number) => ajustar(hex, -delta)
