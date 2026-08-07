import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from '@/game/objects/MatchController'
import { fixed as F, table as T } from '@zinc-pool/engine-physics'

/**
 * Declaração da caçapa, na mesa.
 *
 * A WPA manda dizer ANTES em qual buraco a bola 8 vai cair. Sem a declaração,
 * `canShoot` é falso e a mesa hotseat simplesmente parava de aceitar tacada —
 * o jogador via a mira sumir sem nenhuma explicação e a partida não tinha como
 * continuar.
 *
 * A escolha é feita no canvas, clicando na caçapa: a mesa em rede pergunta em
 * HTML porque tem painel lateral, mas o hotseat não tem, e mostrar seis botões
 * de texto obrigaria o jogador a traduzir "superior direita" para um buraco.
 *
 * O que fica guardado é o ÍNDICE da caçapa em `POCKETS`, e é ele que vai para o
 * replay. A ordem daquela lista é parte do formato: trocá-la faria replays
 * antigos apontarem outro buraco declarado.
 */
export class CallPocketObject extends Entity {
  constructor(private readonly match: MatchController) {
    super('CallPocket')
    this.order = 30 // acima do taco e da bola na mão
  }

  /** Esperando a declaração desta tacada. */
  get ativo(): boolean {
    if (!this.match.callRequired || this.match.calledPocket !== null) return false
    if (this.match.phase !== 'aiming') return false

    // Decisão pendente e bola na mão vêm antes na ordem das regras; desenhar as
    // três ao mesmo tempo daria ao jogador escolhas que ele ainda não tem.
    if (this.match.pending !== null || this.match.ballInHand !== null) return false

    // Numa mesa em rede quem pergunta é o painel de `netmain`. Perguntar aqui
    // também deixaria duas interfaces disputando a mesma escolha.
    if (this.match.net) return false

    return true
  }

  override update({ input, viewport }: FrameContext): void {
    if (!this.ativo || !input.releasedThisFrame) return

    const escolhida = this.#cacapaSob(input.position, viewport)
    if (escolhida !== null) this.match.calledPocket = escolhida
  }

  /**
   * Qual caçapa está sob o ponteiro.
   *
   * A área de clique é maior que a boca desenhada porque a caçapa tem 5 cm num
   * canvas que encolhe com a janela — no celular a boca real tem poucos pixels
   * e errar o toque devolveria o jogador ao mesmo impasse.
   */
  #cacapaSob(
    ponteiro: { x: number; y: number },
    viewport: FrameContext['viewport'],
  ): number | null {
    const alcance = Math.max(22, F.toNumber(T.POCKET_RADIUS) * viewport.scale * 1.8)

    for (let i = 0; i < T.POCKETS.length; i++) {
      const centro = viewport.toScreenFixed(T.POCKETS[i]!.center.x, T.POCKETS[i]!.center.y)
      if (Math.hypot(centro.x - ponteiro.x, centro.y - ponteiro.y) <= alcance) return i
    }

    return null
  }

  override render(ctx: FrameContext): void {
    if (this.ativo) this.#pedirDeclaracao(ctx)
    else if (this.match.calledPocket !== null) this.#marcarEscolhida(ctx)
  }

  /** Anéis pulsando nas seis caçapas, mais o pedido escrito. */
  #pedirDeclaracao({ ctx, viewport, time }: FrameContext): void {
    const raio = F.toNumber(T.POCKET_RADIUS) * viewport.scale
    // Pulso lento: o que precisa chamar atenção é que existe uma escolha, não
    // piscar em cima da mesa enquanto o jogador pensa.
    const pulso = 0.55 + Math.sin(time.elapsed * 3) * 0.25

    ctx.save()
    ctx.lineWidth = 2
    ctx.strokeStyle = `rgba(232, 196, 119, ${pulso.toFixed(3)})`

    for (const cacapa of T.POCKETS) {
      const p = viewport.toScreenFixed(cacapa.center.x, cacapa.center.y)
      ctx.beginPath()
      ctx.arc(p.x, p.y, raio * 1.35, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = '#e8c477'
    ctx.fillText(
      'Toque na caçapa onde a bola 8 vai cair',
      viewport.offsetX + viewport.tableWidthPx / 2,
      viewport.offsetY + viewport.tableHeightPx / 2,
    )
  }

  /** Marca a caçapa declarada até a tacada acontecer. */
  #marcarEscolhida({ ctx, viewport }: FrameContext): void {
    const cacapa = T.POCKETS[this.match.calledPocket!]
    if (!cacapa) return

    const p = viewport.toScreenFixed(cacapa.center.x, cacapa.center.y)
    const raio = F.toNumber(T.POCKET_RADIUS) * viewport.scale

    ctx.save()
    ctx.strokeStyle = 'rgba(232, 196, 119, 0.9)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(p.x, p.y, raio * 1.35, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
