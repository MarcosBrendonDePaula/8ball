import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from '@/game/objects/MatchController'
import { fixed as F, table as T } from '@zinc-pool/engine-physics'

/**
 * Colocação da branca depois de uma falta.
 *
 * Objeto separado do taco de propósito: enquanto há bola na mão, NÃO existe
 * mira — a branca nem está na mesa. Misturar os dois modos no mesmo objeto
 * produziria um taco apontando para uma bola que não está lá.
 *
 * A posição escolhida é entrada do jogador, como o ângulo da tacada, e por isso
 * vai gravada no replay. Sem ela a verificação reproduziria a partida de um
 * ponto que ninguém escolheu.
 */

/** Metade da mesa, atrás da linha da cabeça. */
const LIMITE_COZINHA = F.toNumber(T.HEAD_STRING_X)

export class BallInHandObject extends Entity {
  /** Onde o ponteiro está, em coordenadas do mundo. */
  #alvo: { x: number; y: number } | null = null

  constructor(private readonly match: MatchController) {
    super('BallInHand')
    this.order = 25 // acima das bolas e do taco
  }

  get ativo(): boolean {
    return this.match.ballInHand !== null && this.match.phase === 'aiming'
  }

  override update({ input, viewport }: FrameContext): void {
    if (!this.ativo) {
      this.#alvo = null
      return
    }

    const mundo = viewport.toWorld(input.position.x, input.position.y)
    this.#alvo = this.#valida(mundo)

    // Só coloca ao SOLTAR: arrastar até a posição certa antes de confirmar é o
    // que todo jogo de sinuca faz, e evita colocar a bola num clique acidental.
    if (input.releasedThisFrame && this.#alvo) {
      this.match.placeCueBall(this.#alvo.x, this.#alvo.y)
      this.#alvo = null
    }
  }

  /**
   * Prende a posição na área permitida.
   *
   * A região `kitchen` é a metade atrás da linha da cabeça, onde a WPA manda a
   * bola depois de falta na quebra. Prender aqui evita mandar ao servidor uma
   * posição que ele recusaria — e o servidor prende de novo, porque um cliente
   * adulterado não passa por este código.
   */
  #valida(p: { x: number; y: number }): { x: number; y: number } {
    const raio = F.toNumber(T.BALL_RADIUS)
    const maxX =
      this.match.ballInHand === 'kitchen'
        ? LIMITE_COZINHA - raio
        : F.toNumber(T.WIDTH) - raio

    return {
      x: Math.max(raio, Math.min(maxX, p.x)),
      y: Math.max(raio, Math.min(F.toNumber(T.HEIGHT) - raio, p.y)),
    }
  }

  override render({ ctx, viewport }: FrameContext): void {
    if (!this.ativo) return

    const raio = F.toNumber(T.BALL_RADIUS)

    // Sombreia a área proibida, se houver: mais claro que escrever a regra.
    if (this.match.ballInHand === 'kitchen') {
      const de = viewport.toScreen(LIMITE_COZINHA, F.toNumber(T.HEIGHT))
      const ate = viewport.toScreen(F.toNumber(T.WIDTH), 0)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
      ctx.fillRect(de.x, de.y, ate.x - de.x, ate.y - de.y)
    }

    if (!this.#alvo) return

    const tela = viewport.toScreen(this.#alvo.x, this.#alvo.y)
    const r = raio * viewport.scale

    // Contorno tracejado: a bola ainda não está posta, e um círculo sólido
    // pareceria já colocada.
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(tela.x, tela.y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
