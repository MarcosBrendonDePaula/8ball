import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from './MatchController'

/**
 * Placar e estado da partida, desenhados sobre a mesa.
 *
 * Lê apenas o `summary` do controlador — o resumo que toda modalidade sabe
 * produzir. Por isso este objeto funciona igual no 8-Ball e na sinuca sem uma
 * única ramificação: se um dia entrar snooker, ele já está pronto.
 */
export class HudObject extends Entity {
  constructor(private readonly match: MatchController) {
    super('Hud')
    this.order = 100 // por cima de tudo
  }

  override render({ ctx, viewport }: FrameContext): void {
    const resumo = this.match.summary
    const topo = viewport.offsetY - viewport.margin - 8

    ctx.textBaseline = 'bottom'

    // Vez / vencedor, à esquerda.
    ctx.textAlign = 'left'
    ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = resumo.finished ? '#4fd18b' : '#e8f3ec'
    ctx.fillText(
      resumo.finished ? resumo.status : `Vez do jogador ${resumo.turn + 1}`,
      viewport.offsetX - viewport.margin,
      topo,
    )

    // Situação da partida, no centro.
    if (!resumo.finished) {
      ctx.textAlign = 'center'
      ctx.font = '400 12px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = '#8fae9d'
      ctx.fillText(resumo.status, viewport.offsetX + viewport.tableWidthPx / 2, topo)
    }

    // Placar, à direita. Só as modalidades que pontuam.
    ctx.textAlign = 'right'
    const direita = viewport.offsetX + viewport.tableWidthPx + viewport.margin

    if (resumo.score) {
      ctx.font = '600 15px ui-monospace, monospace'
      ctx.fillStyle = '#e8c477'
      ctx.fillText(`${resumo.score[0]} × ${resumo.score[1]}`, direita, topo)
    } else {
      ctx.font = '400 12px ui-monospace, monospace'
      ctx.fillStyle = '#8fae9d'
      ctx.fillText(`${resumo.onTable.length} na mesa`, direita, topo)
    }

    if (this.match.lastMessage) this.#mensagem(ctx, viewport, this.match.lastMessage)
    if (this.match.phase === 'aiming') this.#dica(ctx, viewport)
  }

  /** Faixa abaixo da mesa com o que acabou de acontecer. */
  #mensagem(
    ctx: CanvasRenderingContext2D,
    vp: FrameContext['viewport'],
    texto: string,
  ): void {
    const y = vp.offsetY + vp.tableHeightPx + vp.margin + 18

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '500 13px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = texto.includes('+') ? '#4fd18b' : '#ff8480'
    ctx.fillText(texto, vp.offsetX + vp.tableWidthPx / 2, y)
  }

  #dica(ctx: CanvasRenderingContext2D, vp: FrameContext['viewport']): void {
    const y = vp.offsetY + vp.tableHeightPx + vp.margin + 38

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = '#4a6a56'
    ctx.fillText(this.#textoDaDica(), vp.offsetX + vp.tableWidthPx / 2, y)
  }

  /**
   * A dica precisa acompanhar o que o jogo está esperando.
   *
   * Mandar arrastar a branca enquanto a regra exige uma declaração é pior que
   * não dizer nada: o jogador tenta, não acontece nada, e conclui que travou.
   */
  #textoDaDica(): string {
    if (this.match.pending) return 'Escolha uma das opções na mesa'
    if (this.match.ballInHand) return 'Solte a branca onde quiser jogar'
    if (this.match.callRequired && this.match.calledPocket === null) {
      return 'Declare a caçapa antes de tacar'
    }
    return 'Arraste a partir da branca e solte para tacar'
  }
}
