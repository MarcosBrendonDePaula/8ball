import { Entity, type FrameContext } from '@/game/core/entity'
import type { MatchController } from '@/game/objects/MatchController'

/**
 * Escolha aberta pelas regras, desenhada sobre a mesa.
 *
 * Uma quebra irregular no 8-Ball dá ao adversário o direito de aceitar a mesa,
 * mandar quebrar de novo ou devolver a quebra. Enquanto a escolha está aberta
 * as regras RECUSAM a próxima tacada — sem uma interface para ela, a mesa
 * hotseat travava sem dizer por quê, e a única saída era recarregar a página.
 *
 * A escolha é entrada do jogador como a tacada, e por isso `MatchController`
 * grava o índice no replay antes de aplicá-la. A ORDEM das opções vem das
 * regras e é parte do formato: esta tela desenha na ordem em que as recebe e
 * nunca reordena.
 */

/** Medidas do painel, em pixels. Não escalam: são interface, não mesa. */
const LARGURA = 250
const ALTURA_BOTAO = 34
const ESPACO = 8

type Botao = { x: number; y: number; w: number; h: number; indice: number }

export class DecisionObject extends Entity {
  constructor(private readonly match: MatchController) {
    super('Decision')
    this.order = 40 // acima da declaração de caçapa
  }

  get ativo(): boolean {
    // Numa mesa em rede é o painel de `netmain` que pergunta, e só a quem tem o
    // direito de escolher. Duplicar aqui deixaria o adversário clicar também.
    return this.match.pending !== null && !this.match.net
  }

  override update({ input, viewport }: FrameContext): void {
    if (!this.ativo || !input.releasedThisFrame) return

    for (const botao of this.#botoes(viewport)) {
      if (dentro(input.position, botao)) {
        this.match.choose(botao.indice)
        return
      }
    }
  }

  /**
   * Retângulo de cada opção.
   *
   * Uma função só, usada pelo desenho E pelo clique: com duas contas separadas,
   * bastaria mudar uma medida para o botão passar a responder num lugar
   * diferente de onde aparece.
   */
  #botoes(viewport: FrameContext['viewport']): Botao[] {
    const opcoes = this.match.pending?.options ?? []
    const alturaTotal = opcoes.length * (ALTURA_BOTAO + ESPACO) - ESPACO

    const x = viewport.offsetX + (viewport.tableWidthPx - LARGURA) / 2
    const topo = viewport.offsetY + (viewport.tableHeightPx - alturaTotal) / 2 + 14

    return opcoes.map((_, i) => ({
      x,
      y: topo + i * (ALTURA_BOTAO + ESPACO),
      w: LARGURA,
      h: ALTURA_BOTAO,
      indice: i,
    }))
  }

  override render({ ctx, viewport, input }: FrameContext): void {
    if (!this.ativo) return

    const pendencia = this.match.pending!
    const botoes = this.#botoes(viewport)

    // Escurece a mesa: com a escolha aberta não há tacada possível, e uma mesa
    // com aparência normal convidaria o jogador a tentar mirar.
    ctx.fillStyle = 'rgba(4, 12, 8, 0.62)'
    ctx.fillRect(viewport.offsetX, viewport.offsetY, viewport.tableWidthPx, viewport.tableHeightPx)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = '#e8f3ec'
    ctx.fillText(
      `Jogador ${pendencia.chooser + 1} escolhe`,
      viewport.offsetX + viewport.tableWidthPx / 2,
      (botoes[0]?.y ?? viewport.offsetY) - 22,
    )

    ctx.font = '500 13px ui-sans-serif, system-ui, sans-serif'

    for (const botao of botoes) {
      const sob = dentro(input.position, botao)

      ctx.fillStyle = sob ? 'rgba(79, 209, 139, 0.22)' : 'rgba(255, 255, 255, 0.07)'
      ctx.strokeStyle = sob ? '#4fd18b' : 'rgba(255, 255, 255, 0.25)'
      ctx.lineWidth = 1.5

      ctx.beginPath()
      ctx.roundRect(botao.x, botao.y, botao.w, botao.h, 8)
      ctx.fill()
      ctx.stroke()

      ctx.fillStyle = '#e8f3ec'
      ctx.fillText(
        pendencia.options[botao.indice] ?? '',
        botao.x + botao.w / 2,
        botao.y + botao.h / 2,
      )
    }
  }
}

const dentro = (p: { x: number; y: number }, r: Botao): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
