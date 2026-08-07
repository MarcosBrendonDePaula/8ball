import * as F from './fixed'
import { applyShot, CUE_BALL, jitterFromSeed, rackBalls, type Shot } from './replay'
import { hashState } from './hash'
import * as T from './table'
import * as V from './vec'

/**
 * Bateria de partidas de referência.
 *
 * Serve a dois propósitos, e os dois são o coração do M1:
 *
 * 1. REGRESSÃO — o teste roda a bateria e compara com os hashes gravados. Se
 *    alguém mexer na física sem querer, um hash muda e o build quebra. Mexer
 *    de propósito exige regravar os hashes, o que força a decisão a ser
 *    consciente e a aparecer no diff.
 *
 * 2. PARIDADE ENTRE PLATAFORMAS — o navegador roda a MESMA bateria e compara
 *    com os mesmos hashes. É assim que se prova que Chrome, Firefox e o
 *    servidor concordam, que é a premissa de todo o desenho.
 *
 * Gerar a bateria não usa aleatoriedade: os parâmetros vêm de uma sequência
 * aritmética, então a bateria é a mesma em qualquer lugar.
 */

export type Fixture = {
  name: string
  seedByte: number
  shots: Array<{ angleDeg: number; power: number; spinX?: number; spinY?: number; massBps?: number }>
}

/** Parâmetros espalhados pelo espaço de tacadas, sem aleatório. */
export const FIXTURES: readonly Fixture[] = Array.from({ length: 24 }, (_, i) => ({
  name: `partida-${i.toString().padStart(2, '0')}`,
  seedByte: (i * 37 + 11) % 256,
  shots: Array.from({ length: 6 }, (_, j) => ({
    angleDeg: (i * 53 + j * 71) % 360,
    power: 0.25 + ((i * 7 + j * 13) % 76) / 100,
    ...(j % 3 === 0 ? { massBps: 8_500 + ((i * 91 + j * 37) % 3_001) } : {}),
    ...(j % 2 === 1
      ? { spinX: (((i * 29 + j * 17) % 21) - 10) / 10, spinY: (((i * 43 + j * 11) % 21) - 10) / 10 }
      : {}),
  })),
}))

/**
 * Roda uma partida da bateria e devolve o hash final.
 *
 * Bola na mão é resolvida de forma determinística — recolocar no ponto de
 * saque —, porque a bateria mede a FÍSICA, não a regra. Regra é o M2.
 */
export function runFixture(fixture: Fixture): string {
  const state = rackBalls(jitterFromSeed(new Uint8Array(32).fill(fixture.seedByte)))
  const hashes: string[] = [hashState(state)]

  for (const shot of fixture.shots) {
    const cue = state.balls[CUE_BALL]!
    if (cue.pocketed) {
      cue.pocketed = false
      V.copy(cue.position, T.CUE_SPOT)
      V.set(cue.velocity, 0, 0)
    }

    const entrada: Shot = {
      intent: {
        angle: F.from((shot.angleDeg * Math.PI) / 180),
        power: F.from(shot.power),
        ...(shot.spinX !== undefined && shot.spinY !== undefined
          ? { spin: { x: F.from(shot.spinX), y: F.from(shot.spinY) } }
          : {}),
      },
      ...(shot.massBps
        ? {
            cue: {
              massBps: shot.massBps,
              spinBps: 10_000,
              aimBps: 10_000,
              clothGripBps: 10_000,
              breakBonusBps: 10_000,
            },
          }
        : {}),
      // A primeira tacada de cada partida é a quebra.
      isBreak: shot === fixture.shots[0],
    }

    const resultado = applyShot(state, entrada)
    hashes.push(resultado.stateHash, resultado.eventsHash)
  }

  return hashes.join(':')
}

/** Roda a bateria inteira. É isto que precisa bater em toda plataforma. */
export function runAllFixtures(): Record<string, string> {
  const resultado: Record<string, string> = {}
  for (const fixture of FIXTURES) resultado[fixture.name] = runFixture(fixture)
  return resultado
}

/** Hash único da bateria inteira — um valor só para comparar entre máquinas. */
export function fixturesDigest(): string {
  const todos = runAllFixtures()
  let acumulado = 0x811c9dc5

  for (const nome of Object.keys(todos).sort()) {
    for (const caractere of `${nome}=${todos[nome]}`) {
      acumulado = Math.imul(acumulado ^ caractere.charCodeAt(0), 0x01000193) >>> 0
    }
  }
  return (acumulado >>> 0).toString(16).padStart(8, '0')
}
