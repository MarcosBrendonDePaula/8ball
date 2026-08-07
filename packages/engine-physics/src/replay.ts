import {
  bpsToFixed,
  clampCue,
  DEFAULT_CUE,
  quantizeAim,
  shotPowerBpsFor,
  spinDecayFor,
  type CueParams,
} from './cue'
import * as F from './fixed'
import type { Fixed } from './fixed'
import { hashEvents, hashState } from './hash'
import { createBall, simulate, type CollisionEvent, type TableState } from './sim'
import * as T from './table'
import * as V from './vec'

/**
 * Montagem da mesa e execução de tacadas.
 *
 * É a fronteira da engine: o resto do sistema fala com estas funções e nunca
 * mexe em bola diretamente. Tudo aqui é determinístico — sem relógio, sem
 * aleatório, sem estado global.
 */

/** Índice fixo da bola branca. As numeradas são 1 a 15. */
export const CUE_BALL = 0

/**
 * Intenção de tacada — o ÚNICO dado que o cliente envia.
 *
 * O cliente nunca informa onde as bolas pararam; manda o vetor e o servidor
 * calcula o resto (docs/TDD.md §4.3).
 */
export type ShotIntent = {
  /** Direção, em radianos, já em ponto fixo. */
  angle: Fixed
  /** Força de 0 a 1, em ponto fixo. */
  power: Fixed
  /**
   * Ponto de contato do taco na branca, de -1 a 1 em cada eixo.
   * `x` lateral (inglês), `y` vertical (positivo corre, negativo recua).
   */
  spin?: { x: Fixed; y: Fixed }
}

/**
 * Tacada completa: a intenção do jogador mais o taco usado.
 *
 * O taco entra aqui, e não na intenção, porque quem o determina é o servidor a
 * partir do NFT que a carteira possui. Se viesse junto da intenção, seria
 * campo controlado pelo cliente — e taco lendário de graça.
 */
export type Shot = {
  intent: ShotIntent
  cue?: CueParams
  /** Quebra: habilita o bônus de potência do taco. O servidor decide, não o cliente. */
  isBreak?: boolean
}

/** Velocidade da branca com a força no máximo e taco padrão. */
export const MAX_SHOT_SPEED: Fixed = F.from(12)

/** Efeito máximo que um taco padrão imprime. */
export const MAX_SPIN: Fixed = F.from(2.5)

/**
 * Monta o triângulo de 15 bolas no ponto de pé.
 *
 * O `jitter` é o deslocamento sub-milimétrico derivado do commit-reveal dos
 * dois jogadores (TDD §4.4). Sem ele a quebra vira um problema resolvido:
 * alguém acha o vetor ótimo e ganha toda partida em que quebra.
 */
export function rackBalls(jitter: readonly Fixed[] = []): TableState {
  const balls = [createBall(CUE_BALL, T.CUE_SPOT.x, T.CUE_SPOT.y)]

  // Espaçamento levemente maior que o diâmetro, para as bolas não nascerem
  // em contato — o que dispararia colisões antes da primeira tacada.
  const passo = T.CONTACT_DISTANCE + F.from(0.0005)
  const alturaLinha = F.mul(passo, F.from(0.866)) // sen(60°)

  let id = 1
  for (let linha = 0; linha < 5; linha++) {
    const x = T.FOOT_SPOT.x + F.mul(alturaLinha, F.fromInt(linha))
    const yBase = T.FOOT_SPOT.y - F.mul(F.div(passo, F.fromInt(2)), F.fromInt(linha))

    for (let coluna = 0; coluna <= linha; coluna++) {
      const y = yBase + F.mul(passo, F.fromInt(coluna))

      const dx = jitter[(id - 1) * 2] ?? 0
      const dy = jitter[(id - 1) * 2 + 1] ?? 0

      balls.push(createBall(id, x + dx, y + dy))
      id++
    }
  }
  return { balls }
}

/** Deriva o jitter de um seed de 32 bytes (o `hash(nonceA ‖ nonceB)`). */
export function jitterFromSeed(seed: Uint8Array): Fixed[] {
  const valores: Fixed[] = []
  // ±0.2mm: suficiente para mudar a quebra, invisível para o jogador.
  const amplitude = F.from(0.0002)

  for (let i = 0; i < 30; i++) {
    const byte = seed[i % seed.length] ?? 0
    // Mapeia 0..255 para -amplitude..+amplitude.
    valores.push(Math.floor((amplitude * 2 * (byte - 128)) / 255))
  }
  return valores
}

export type ShotResult = {
  events: CollisionEvent[]
  /** Atributos efetivamente aplicados, já limitados. Vão para o replay. */
  cue: CueParams
  /** Ângulo depois de encaixado na grade do taco — o que de fato foi jogado. */
  aimedAngle: Fixed
  stateHash: string
  eventsHash: string
}

/**
 * Aplica a tacada à branca, SEM simular.
 *
 * Existe separado porque o cliente precisa animar: ele dá o impulso e depois
 * avança quadro a quadro, enquanto o servidor simula tudo de uma vez. Os dois
 * partem exatamente do mesmo estado inicial, então chegam ao mesmo resultado —
 * que é o que permite a predição local sem divergir.
 */
export function beginShot(state: TableState, shot: Shot): { cue: CueParams; aimedAngle: Fixed } {
  const branca = state.balls.find((b) => b.id === CUE_BALL)
  if (!branca) throw new Error('Mesa sem bola branca.')
  if (branca.pocketed) throw new Error('A branca está encaçapada; reposicione antes de jogar.')

  // Prende os atributos mesmo vindos do servidor: um bug em outro lugar não
  // pode virar taco com o dobro da força.
  const taco = clampCue(shot.cue ?? DEFAULT_CUE)

  // A mira cai na grade do taco. Determinístico: mesmo ângulo, mesmo taco,
  // mesmo resultado — sem sorteio, o replay continua reproduzindo a partida.
  const aimedAngle = quantizeAim(shot.intent.angle, taco)

  const forca = F.clamp(shot.intent.power, 0, F.ONE)
  const potencia = shotPowerBpsFor(taco, shot.isBreak === true)
  const velocidade = F.mul(F.mul(MAX_SHOT_SPEED, forca), bpsToFixed(potencia))
  const direcao = V.fromAngle(aimedAngle)

  V.set(branca.velocity, F.mul(direcao.x, velocidade), F.mul(direcao.y, velocidade))

  // Aderência do couro: define quanto o efeito sobrevive ao rolamento.
  branca.spinDecay = spinDecayFor(taco)

  const contato = shot.intent.spin
  if (contato) {
    const autoridade = F.mul(F.mul(MAX_SPIN, forca), bpsToFixed(taco.spinBps))
    V.set(
      branca.spin,
      F.mul(F.clamp(contato.x, -F.ONE, F.ONE), autoridade),
      F.mul(F.clamp(contato.y, -F.ONE, F.ONE), autoridade),
    )
  } else {
    V.set(branca.spin, 0, 0)
  }

  return { cue: taco, aimedAngle }
}

/**
 * Aplica a tacada e simula até tudo parar.
 *
 * Muta o estado recebido — quem precisar do anterior guarda um `cloneState`.
 */
export function applyShot(state: TableState, shot: Shot): ShotResult {
  const { cue, aimedAngle } = beginShot(state, shot)
  const events = simulate(state)

  return {
    events,
    cue,
    aimedAngle,
    stateHash: hashState(state),
    eventsHash: hashEvents(events),
  }
}
