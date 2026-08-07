import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from '@/game/objects/MatchController'

/**
 * Destaque da bola da vez.
 *
 * Na sinuca brasileira as sete coloridas são disputadas em ordem crescente, e
 * na mesa elas parecem igualmente jogáveis: nada distingue a bola obrigatória
 * das outras seis. Sem este anel, o jogador só descobria qual era a da vez
 * lendo o texto do placar — e errar a bola é falta de sete pontos.
 *
 * Quem decide qual bola destacar são as regras (`targetBallOf`), não este
 * objeto. No 8-Ball o alvo é o grupo inteiro, a modalidade devolve `null` e
 * nada é desenhado — que é o comportamento certo, e não um caso especial aqui.
 */
export class TargetBallObject extends Entity {
  constructor(private readonly match: MatchController) {
    super('TargetBall')
    this.order = 15 // acima das bolas, abaixo do taco
  }

  override render({ ctx, viewport, time }: FrameContext): void {
    // Durante a simulação o alvo já é o da PRÓXIMA tacada, e apontá-lo enquanto
    // as bolas rolam anunciaria o resultado antes de ele acontecer.
    if (this.match.phase !== 'aiming') return

    const alvo = this.match.targetBall
    if (alvo === null) return

    const bola = this.match.table.balls.find((b) => b.id === alvo)
    if (!bola || bola.pocketed) return

    const mundo = this.match.interpolated(bola, time.alpha)
    const p = viewport.toScreen(mundo.x, mundo.y)
    const raio = viewport.ballRadiusPx

    ctx.save()
    // Tracejado girando devagar: distingue o anel da bola sem competir com ela.
    // Sólido pareceria parte do desenho da própria bola.
    ctx.setLineDash([5, 5])
    ctx.lineDashOffset = -time.elapsed * 14
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(p.x, p.y, raio * 1.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
