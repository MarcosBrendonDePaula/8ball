import { Entity, type FrameContext } from '@/game/core/entity'
import { fixed as F, table as T } from '@zinc-pool/engine-physics'

/**
 * A mesa: moldura, pano, marcações e caçapas.
 *
 * Só desenha. Não guarda estado de jogo nem reage a entrada — é o fundo sobre
 * o qual tudo acontece, e mantê-lo burro é o que permite trocar a aparência
 * sem risco de quebrar a partida.
 */
export class TableObject extends Entity {
  constructor() {
    super('Table')
    this.order = 0 // primeiro de todos
  }

  override render({ ctx, viewport }: FrameContext): void {
    ctx.clearRect(0, 0, viewport.widthPx, viewport.heightPx)

    this.#moldura(ctx, viewport)
    this.#pano(ctx, viewport)
    this.#marcacoes(ctx, viewport)
    this.#cacapas(ctx, viewport)
  }

  #moldura(ctx: CanvasRenderingContext2D, vp: FrameContext['viewport']): void {
    const m = vp.margin
    ctx.fillStyle = '#3a2a1c'
    arredondado(
      ctx,
      vp.offsetX - m,
      vp.offsetY - m,
      vp.tableWidthPx + m * 2,
      vp.tableHeightPx + m * 2,
      12,
    )
    ctx.fill()

    // Filete claro na borda superior: sugere volume sem custar nada.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  #pano(ctx: CanvasRenderingContext2D, vp: FrameContext['viewport']): void {
    const gradiente = ctx.createLinearGradient(
      vp.offsetX,
      vp.offsetY,
      vp.offsetX,
      vp.offsetY + vp.tableHeightPx,
    )
    gradiente.addColorStop(0, '#17663f')
    gradiente.addColorStop(1, '#104529')

    ctx.fillStyle = gradiente
    ctx.fillRect(vp.offsetX, vp.offsetY, vp.tableWidthPx, vp.tableHeightPx)
  }

  #marcacoes(ctx: CanvasRenderingContext2D, vp: FrameContext['viewport']): void {
    // Linha da cabeça: referência do saque e do limite da cozinha.
    const linha = vp.toScreenFixed(T.HEAD_STRING_X, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(linha.x, vp.offsetY)
    ctx.lineTo(linha.x, vp.offsetY + vp.tableHeightPx)
    ctx.stroke()

    // Ponto de pé, onde o triângulo é montado.
    const pe = vp.toScreenFixed(T.FOOT_SPOT.x, T.FOOT_SPOT.y)
    ctx.fillStyle = 'rgba(255,255,255,0.16)'
    ctx.beginPath()
    ctx.arc(pe.x, pe.y, Math.max(2, vp.scale * 0.004), 0, Math.PI * 2)
    ctx.fill()
  }

  #cacapas(ctx: CanvasRenderingContext2D, vp: FrameContext['viewport']): void {
    const raio = F.toNumber(T.POCKET_RADIUS) * vp.scale

    for (const cacapa of T.POCKETS) {
      const p = vp.toScreenFixed(cacapa.center.x, cacapa.center.y)

      // Boca escura com um anel, para a bola parecer cair dentro.
      const buraco = ctx.createRadialGradient(p.x, p.y, raio * 0.3, p.x, p.y, raio)
      buraco.addColorStop(0, '#000')
      buraco.addColorStop(1, '#0b1a11')

      ctx.fillStyle = buraco
      ctx.beginPath()
      ctx.arc(p.x, p.y, raio, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
}

function arredondado(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
