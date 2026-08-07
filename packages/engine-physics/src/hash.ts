import type { CollisionEvent, TableState } from './sim'

/**
 * Hash determinístico do estado da mesa.
 *
 * FNV-1a sobre os inteiros de ponto fixo. Não é criptográfico — é uma
 * impressão digital barata para comparar duas simulações e detectar
 * divergência entre plataformas.
 *
 * Opera só sobre inteiros, com aritmética de 32 bits explícita (`>>> 0`,
 * `Math.imul`), justamente porque um hash que dependesse de float teria o
 * mesmo problema que ele existe para detectar.
 */

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

export class Hasher {
  #estado = FNV_OFFSET

  /** Absorve um inteiro de 32 bits, byte a byte. */
  int(value: number): this {
    let v = value | 0
    for (let i = 0; i < 4; i++) {
      this.#estado = Math.imul(this.#estado ^ (v & 0xff), FNV_PRIME) >>> 0
      v >>= 8
    }
    return this
  }

  bool(value: boolean): this {
    return this.int(value ? 1 : 0)
  }

  /** Em hexadecimal de 8 dígitos, para comparar e guardar. */
  digest(): string {
    return (this.#estado >>> 0).toString(16).padStart(8, '0')
  }
}

/** Impressão digital das posições finais — o que precisa bater entre máquinas. */
export function hashState(state: TableState): string {
  const h = new Hasher()
  for (const ball of state.balls) {
    h.int(ball.id)
    h.int(ball.position.x)
    h.int(ball.position.y)
    h.int(ball.velocity.x)
    h.int(ball.velocity.y)
    h.bool(ball.pocketed)
  }
  return h.digest()
}

/**
 * Impressão digital da sequência de eventos.
 *
 * Separada do estado de propósito: dois runtimes podem chegar às mesmas
 * posições finais por caminhos diferentes, e é o CAMINHO que o cliente anima.
 * Divergência aqui aparece como som e animação diferentes entre os jogadores.
 */
export function hashEvents(events: readonly CollisionEvent[]): string {
  const h = new Hasher()
  for (const evento of events) {
    switch (evento.type) {
      case 'ball-ball':
        h.int(1).int(evento.a).int(evento.b).int(evento.speed)
        break
      case 'ball-cushion':
        h.int(2).int(evento.ball).int(evento.cushion).int(evento.speed)
        break
      case 'pocketed':
        h.int(3).int(evento.ball).int(evento.pocket)
        break
    }
  }
  return h.digest()
}
