import type { Entity, FrameContext } from './entity'

/**
 * Cena: o conjunto de entidades e a ordem em que elas rodam.
 *
 * Duas garantias que evitam bugs difíceis de achar:
 *
 * 1. `start` só roda depois de TODOS os `awake`. É o que permite uma entidade
 *    procurar outra no `start` sem depender da ordem de criação.
 *
 * 2. Adicionar ou remover entidade no meio de um update não altera a lista que
 *    está sendo percorrida. Sem isso, criar um objeto durante o update pularia
 *    entidades ou rodaria a nova duas vezes.
 */
export class Scene {
  #entities: Entity[] = []
  #pendingAdd: Entity[] = []
  #pendingRemove = new Set<Entity>()
  #started = false

  get entities(): readonly Entity[] {
    return this.#entities
  }

  add<T extends Entity>(entity: T): T {
    this.#pendingAdd.push(entity)
    return entity
  }

  remove(entity: Entity): void {
    this.#pendingRemove.add(entity)
  }

  find<T extends Entity>(name: string): T | null {
    return (this.#entities.find((e) => e.name === name) as T | undefined) ?? null
  }

  /** Prepara as entidades adicionadas antes do primeiro quadro. */
  begin(context: FrameContext): void {
    this.#flush(context)

    // Todos os awake antes de qualquer start: é o que torna seguro uma
    // entidade procurar outra no start.
    for (const e of this.#entities) e.awake?.(context)
    for (const e of this.#entities) e.start?.(context)

    this.#started = true
  }

  fixedUpdate(context: FrameContext): void {
    for (const e of this.#snapshot()) {
      if (e.enabled) e.fixedUpdate?.(context)
    }
  }

  update(context: FrameContext): void {
    for (const e of this.#snapshot()) {
      if (e.enabled) e.update?.(context)
    }
    this.#flush(context)
  }

  render(context: FrameContext): void {
    const ordenadas = [...this.#entities].sort((a, b) => a.order - b.order)
    for (const e of ordenadas) {
      if (e.enabled) e.render?.(context)
    }
  }

  destroy(): void {
    for (const e of this.#entities) e.onDestroy?.()
    this.#entities = []
    this.#pendingAdd = []
    this.#pendingRemove.clear()
  }

  // ------------------------------------------------------------- interno

  /** Cópia da lista, para mutações durante o laço não afetarem a iteração. */
  #snapshot(): Entity[] {
    return [...this.#entities]
  }

  #flush(context: FrameContext): void {
    if (this.#pendingRemove.size > 0) {
      for (const e of this.#pendingRemove) e.onDestroy?.()
      this.#entities = this.#entities.filter((e) => !this.#pendingRemove.has(e))
      this.#pendingRemove.clear()
    }

    if (this.#pendingAdd.length > 0) {
      const novas = this.#pendingAdd
      this.#pendingAdd = []
      this.#entities.push(...novas)

      // Entidade criada depois do início precisa do ciclo completo agora.
      if (this.#started) {
        for (const e of novas) e.awake?.(context)
        for (const e of novas) e.start?.(context)
      }
    }
  }
}
