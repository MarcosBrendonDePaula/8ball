import type { CollisionEvent } from '@zinc-pool/engine-physics'
import { CUE_BALL } from '@zinc-pool/engine-physics'

/**
 * Tradução dos eventos da física para o vocabulário das regras.
 *
 * A física relata colisões; as regras perguntam "qual bola a branca tocou
 * primeiro?" e "alguma bola foi à tabela depois disso?". Este é o único lugar
 * que conhece os dois lados — deixar essa tradução espalhada faria cada tela
 * inventar a própria interpretação dos mesmos eventos.
 */

export type PhysicsOutcome = {
  firstContact: number | null
  pocketed: number[]
  offTable: number[]
  railAfterContact: boolean
  ballsToRail: number
  eightBallPocket: number | null
}

export function outcomeFromEvents(events: readonly CollisionEvent[]): PhysicsOutcome {
  let firstContact: number | null = null
  let contactIndex = -1

  // Primeiro contato: a primeira colisão entre bolas que envolve a branca.
  for (let i = 0; i < events.length; i++) {
    const evento = events[i]!
    if (evento.type !== 'ball-ball') continue
    if (evento.a !== CUE_BALL && evento.b !== CUE_BALL) continue

    firstContact = evento.a === CUE_BALL ? evento.b : evento.a
    contactIndex = i
    break
  }

  const pocketed: number[] = []
  let eightBallPocket: number | null = null
  let railAfterContact = false
  const bolasQueTocaramTabela = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    const evento = events[i]!

    if (evento.type === 'pocketed') {
      pocketed.push(evento.ball)
      if (evento.ball === 8) eightBallPocket = evento.pocket
      continue
    }

    if (evento.type === 'ball-cushion') {
      bolasQueTocaramTabela.add(evento.ball)
      // "Depois do contato" é literal: tabela antes de tocar bola não conta.
      if (contactIndex >= 0 && i > contactIndex) railAfterContact = true
    }
  }

  // Bolas NUMERADAS que foram à tabela — a branca não conta para a quebra.
  bolasQueTocaramTabela.delete(CUE_BALL)

  return {
    firstContact,
    pocketed,
    // A física prende as bolas dentro dos limites, então nada sai da mesa.
    // O campo existe porque as regras preveem o caso; o dia em que houver
    // tacada saltada, é aqui que ele passa a ser preenchido.
    offTable: [],
    railAfterContact,
    ballsToRail: bolasQueTocaramTabela.size,
    eightBallPocket,
  }
}
