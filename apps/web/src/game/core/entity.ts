import type { Input } from './input'
import type { Time } from './time'
import type { Viewport } from './viewport'

/**
 * Contexto passado a cada entidade nos métodos de ciclo de vida.
 *
 * Injeção explícita em vez de singletons globais. Um `Time.deltaTime` estático
 * é conveniente até o dia em que se quer rodar duas cenas ao mesmo tempo — ou
 * testar uma entidade isolada, que é o caso mais comum.
 */
export type FrameContext = {
  time: Time
  input: Input
  viewport: Viewport
  ctx: CanvasRenderingContext2D
}

/**
 * Objeto da cena, no espírito do `MonoBehaviour` da Unity.
 *
 * O ciclo de vida é o mesmo, e pela mesma razão:
 *
 *   awake        uma vez, ao entrar na cena
 *   start        antes do primeiro quadro, quando todos já existem
 *   fixedUpdate  passo FIXO — é onde a física anda
 *   update       uma vez por quadro — entrada e lógica de interface
 *   render       desenho, sem alterar estado
 *   onDestroy    limpeza
 *
 * A separação entre `fixedUpdate` e `update` não é enfeite: física em passo
 * variável produziria resultados diferentes em cada máquina, e este jogo
 * depende de os dois jogadores verem exatamente a mesma partida.
 */
export abstract class Entity {
  /** Nome para depuração e busca na cena. */
  readonly name: string

  /** Entidade desligada não recebe update nem render. */
  enabled = true

  /** Ordem de desenho: menor primeiro. A mesa antes das bolas. */
  order = 0

  constructor(name: string) {
    this.name = name
  }

  awake?(context: FrameContext): void
  start?(context: FrameContext): void
  fixedUpdate?(context: FrameContext): void
  update?(context: FrameContext): void
  render?(context: FrameContext): void
  onDestroy?(): void
}
