import { fixed as F, table as T } from '@zinc-pool/engine-physics'

/**
 * Conversão entre o mundo da física e a tela.
 *
 * A mesa tem tamanho fixo em metros; o canvas varia com a janela. Concentrar a
 * conversão num lugar evita que cada objeto invente a sua — e evita o erro
 * clássico de esquecer que o eixo Y é invertido entre os dois.
 */
export class Viewport {
  scale = 1
  offsetX = 0
  offsetY = 0

  constructor(
    public widthPx: number,
    public heightPx: number,
    /** Margem para a moldura de madeira, em pixels. */
    public margin = 26,
    /**
     * Espaço reservado acima e abaixo para o HUD.
     *
     * Separado da margem de propósito: a margem é moldura da mesa, este é
     * espaço de interface. Misturar os dois faria o texto ser desenhado por
     * cima da madeira — ou, pior, fora do canvas.
     */
    public hudTop = 34,
    public hudBottom = 56,
  ) {
    this.resize(widthPx, heightPx)
  }

  resize(widthPx: number, heightPx: number): void {
    this.widthPx = widthPx
    this.heightPx = heightPx

    const larguraMundo = F.toNumber(T.WIDTH)
    const alturaMundo = F.toNumber(T.HEIGHT)

    const disponivelX = widthPx - this.margin * 2
    const disponivelY = heightPx - this.margin * 2 - this.hudTop - this.hudBottom

    // Mantém a proporção: a mesa nunca distorce, seja qual for a janela.
    this.scale = Math.max(1, Math.min(disponivelX / larguraMundo, disponivelY / alturaMundo))

    this.offsetX = (widthPx - larguraMundo * this.scale) / 2
    // Centraliza no espaço que sobra depois do HUD, não na tela inteira.
    this.offsetY =
      this.hudTop +
      (heightPx - this.hudTop - this.hudBottom - alturaMundo * this.scale) / 2
  }

  /** Mundo em metros → pixels. */
  toScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: this.offsetX + x * this.scale,
      // Y invertido: no mundo cresce para cima, no canvas para baixo.
      y: this.offsetY + (F.toNumber(T.HEIGHT) - y) * this.scale,
    }
  }

  /** Mundo em ponto fixo → pixels. Atalho para desenhar direto do estado. */
  toScreenFixed(x: F.Fixed, y: F.Fixed): { x: number; y: number } {
    return this.toScreen(F.toNumber(x), F.toNumber(y))
  }

  /** Pixels → mundo. Traduz o clique do jogador em posição de mesa. */
  toWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.offsetX) / this.scale,
      y: F.toNumber(T.HEIGHT) - (py - this.offsetY) / this.scale,
    }
  }

  get ballRadiusPx(): number {
    return F.toNumber(T.BALL_RADIUS) * this.scale
  }

  get tableWidthPx(): number {
    return F.toNumber(T.WIDTH) * this.scale
  }

  get tableHeightPx(): number {
    return F.toNumber(T.HEIGHT) * this.scale
  }
}
