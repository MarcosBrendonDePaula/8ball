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

  const passo = T.CONTACT_DISTANCE + RACK_GAP
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

/**
 * Folga entre as bolas do triângulo, antes do jitter.
 *
 * Existe para as bolas não nascerem em contato, o que dispararia colisões
 * antes da primeira tacada. É este número que limita o quanto cada bola pode
 * ser deslocada — ver `BALL_JITTER`.
 */
export const RACK_GAP: Fixed = F.from(0.0005)

/**
 * Deslocamento do triângulo inteiro, em cada eixo. Física v2.
 *
 * ±2 mm é o que dá para extrair de um byte com resolução útil: em Q16.16 uma
 * unidade vale 0,015 mm, então esta amplitude cobre 261 posições distintas por
 * eixo — praticamente toda a entropia dos 256 valores de um byte.
 */
export const RACK_SHIFT: Fixed = F.from(0.002)

/**
 * Deslocamento individual de cada bola.
 *
 * NÃO PODE PASSAR DE METADE DA FOLGA DO RACK. As bolas nascem com 0,503 mm
 * entre elas; se duas vizinhas se aproximarem mais que isso, nascem
 * sobrepostas e a simulação dispara colisões antes da primeira tacada.
 *
 * Duas coisas tornam a conta pior do que parece, e as duas já morderam:
 *
 *   - o deslocamento é por EIXO, então na diagonal ele vale amplitude·√2
 *   - o `floor` do mapeamento estende a faixa para −11..+9 unidades quando a
 *     amplitude nominal é 10, porque arredondar para baixo nunca encurta o
 *     lado negativo
 *
 * Com 0,1 mm a faixa real é −8..+6 unidades, a aproximação máxima entre duas
 * vizinhas é ~23 unidades e a folga disponível é ~32. Sobra margem de verdade.
 *
 * A v1 usava ±0,2 mm e ignorava as duas correções: sobrepunha bolas em quase
 * todo rack, sem nada acusando — a simulação simplesmente começava resolvendo
 * colisões que não deviam existir. Não havia teste de sobreposição. Agora há.
 *
 * A entropia da quebra não depende mais deste número: ela mora em
 * `RACK_SHIFT`, que desloca o triângulo inteiro sem alterar as distâncias.
 */
export const BALL_JITTER: Fixed = F.from(0.0001)

/**
 * Deriva o jitter de um seed de 32 bytes (o `hash(nonceA ‖ nonceB)`).
 *
 * Sem isto a quebra vira um problema resolvido: alguém acha o vetor ótimo e
 * ganha toda partida em que quebra.
 *
 * Duas camadas, e a divisão não é estética — é o que permite amplitude grande
 * sem quebrar o triângulo:
 *
 *   - o RACK INTEIRO desliza até ±2 mm, o que move onde a branca acerta a bola
 *     da frente e muda a quebra por completo. Como todas as bolas andam junto,
 *     a distância entre elas não muda e nenhuma nasce sobreposta.
 *   - cada BOLA ainda desloca ±0,2 mm por conta própria, o mínimo para o
 *     aglomerado não ser idêntico a cada rack.
 *
 * A tentativa óbvia — dar ±2 mm a cada bola — foi medida e sobrepõe bolas em
 * 100% dos seeds, até 3,75 mm. Alargar o rack para acomodar isso deixaria as
 * bolas soltas, e num rack real elas estão coladas: é assim que a energia da
 * quebra atravessa o aglomerado.
 */
export function jitterFromSeed(seed: Uint8Array): Fixed[] {
  const valores: Fixed[] = []

  // Dois bytes dedicados ao deslize do rack, fora do laço das bolas, para o
  // valor não depender de quantas bolas a modalidade usa.
  const deslizeX = espalhar(seed[30] ?? 0, RACK_SHIFT)
  const deslizeY = espalhar(seed[31] ?? 0, RACK_SHIFT)

  for (let i = 0; i < 30; i++) {
    const byte = seed[i % seed.length] ?? 0
    const proprio = espalhar(byte, BALL_JITTER)
    valores.push(proprio + (i % 2 === 0 ? deslizeX : deslizeY))
  }
  return valores
}

/** Mapeia 0..255 para -amplitude..+amplitude, com arredondamento uniforme. */
const espalhar = (byte: number, amplitude: Fixed): Fixed =>
  Math.floor((amplitude * 2 * (byte - 128)) / 255)

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
