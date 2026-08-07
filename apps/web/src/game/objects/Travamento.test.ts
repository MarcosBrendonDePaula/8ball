import { MatchController } from '@/game/objects/MatchController'
import { table as T } from '@zinc-pool/engine-physics'
import { GAME_MODES, type GameModeId } from '@zinc-pool/engine-rules'
import { describe, expect, test } from 'bun:test'

/**
 * O jogo nunca pode ficar sem ação possível.
 *
 * Toda vez que a interface do hotseat ficou devendo uma pergunta às regras, o
 * sintoma foi o mesmo: uma partida que simplesmente parava de aceitar tacada,
 * sem mensagem, e só voltava recarregando a página. Foi assim com a caçapa
 * declarada e com a decisão pendente.
 *
 * Este teste joga partidas inteiras das duas modalidades e falha no instante em
 * que o estado não oferece NENHUMA das ações que a mesa sabe executar —
 * escolher, posicionar a branca, declarar ou tacar. Ele existe para pegar a
 * PRÓXIMA regra que abrir uma exigência sem interface, não as duas já
 * conhecidas.
 */

/** Ações que a mesa hotseat sabe executar, tentadas na ordem das regras. */
function jogarAteOFim(modo: GameModeId, semente: number): void {
  const match = new MatchController(modo, semente)

  for (let i = 0; i < 80; i++) {
    if (match.summary.finished) return

    // Estourar um teto do replay encerra a partida por falta de espaço, o que é
    // comportamento declarado — não é travamento.
    if (match.recorder.remaining <= 0) return

    if (match.pending) {
      match.choose(i % match.pending.options.length)
      continue
    }

    if (match.ballInHand) {
      if (match.recorder.remainingPlacements <= 0) return
      match.placeCueBall(
        match.ballInHand === 'kitchen' ? 0.3 : 0.4 + ((i * 7) % 10) / 20,
        0.2 + ((i * 3) % 8) / 20,
      )
      continue
    }

    if (match.callRequired) {
      if (match.recorder.remainingCalls <= 0) return
      match.calledPocket = i % 6
    }

    if (!match.canShoot) {
      throw new Error(
        `Partida sem ação possível: modo=${modo} semente=${semente} tacada=${i} ` +
          `fase=${match.phase} situação="${match.summary.status}"`,
      )
    }

    match.shoot((i * 2.399963 + semente * 0.7) % (Math.PI * 2), 0.4 + ((i * 7 + semente) % 13) / 20, {
      x: (((i * 5) % 7) - 3) / 6,
      y: (((i * 3) % 5) - 2) / 5,
    })

    for (let passo = 0; passo < T.MAX_STEPS + 10 && match.phase === 'simulating'; passo++) {
      match.fixedUpdate()
    }

    if (match.phase === 'simulating') {
      throw new Error(`A tacada ${i} não terminou dentro do limite de passos.`)
    }
  }
}

describe('partida completa nunca fica sem saída', () => {
  for (const modo of GAME_MODES) {
    // Sementes variadas porque a quebra muda a partida inteira: um travamento
    // pode depender de uma situação que só aparece em certas mesas.
    for (const semente of [1, 3, 5, 7, 9, 11]) {
      test(`${modo}: semente ${semente} chega ao fim com ação em toda etapa`, () => {
        expect(() => jogarAteOFim(modo, semente)).not.toThrow()
      })
    }
  }
})
