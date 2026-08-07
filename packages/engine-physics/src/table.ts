import * as F from './fixed'
import type { Fixed } from './fixed'
import * as V from './vec'
import type { Vec } from './vec'

/**
 * Versão da FÍSICA.
 *
 * Diferente da versão do formato de replay: esta identifica o COMPORTAMENTO.
 * Qualquer mudança que altere onde as bolas param — atrito, restituição, passo
 * de integração, geometria — obriga a incrementar este número.
 *
 * Sem isso, um replay gravado hoje seria reproduzido amanhã com uma física
 * diferente e daria outro vencedor. O teste em `fixtures.test.ts` compara o
 * digest da bateria com o declarado abaixo e falha se alguém mudar a física
 * sem incrementar aqui.
 */
export const ENGINE_VERSION = 1

/**
 * Impressão digital da física desta versão.
 *
 * É o digest da bateria de referência. Um verificador independente roda a
 * bateria, compara com este valor, e sabe se está executando a mesma física
 * que gravou o replay.
 */
export const PHYSICS_DIGEST = '1751bd8c'

/**
 * Geometria da mesa e constantes físicas.
 *
 * Medidas de uma mesa de 7 pés (a mais comum para 8-Ball), em metros. Todos os
 * valores viram Q16.16 UMA VEZ aqui — é o único lugar do módulo onde um número
 * real entra, e é o que mantém o float fora do laço da simulação.
 *
 * Origem no canto inferior esquerdo do pano; x cresce para a direita, y para
 * cima.
 */

/** Área de jogo: 1.98m × 0.99m. */
export const WIDTH: Fixed = F.from(1.98)
export const HEIGHT: Fixed = F.from(0.99)

/** Bola de 57.15mm de diâmetro. */
export const BALL_RADIUS: Fixed = F.from(0.0285_75)
export const BALL_DIAMETER: Fixed = BALL_RADIUS * 2

/** Distância entre centros no momento do contato. */
export const CONTACT_DISTANCE: Fixed = BALL_DIAMETER
export const CONTACT_DISTANCE_SQ: Fixed = F.sqr(CONTACT_DISTANCE)

/** Raio de captura da caçapa, medido do centro dela ao centro da bola. */
export const POCKET_RADIUS: Fixed = F.from(0.05)
export const POCKET_RADIUS_SQ: Fixed = F.sqr(POCKET_RADIUS)

/**
 * Desaceleração por atrito de rolamento, em m/s².
 *
 * Calibrada para uma tacada média parar em poucos segundos, que é o que dá a
 * sensação certa. Vira um número exato em Q16.16, então é reproduzível.
 */
export const ROLLING_FRICTION: Fixed = F.from(0.45)

/** Abaixo disto a bola é considerada parada, evitando deslizar para sempre. */
export const REST_SPEED: Fixed = F.from(0.01)
export const REST_SPEED_SQ: Fixed = F.sqr(REST_SPEED)

/** Quanto da velocidade sobra ao bater na tabela. */
export const CUSHION_RESTITUTION: Fixed = F.from(0.75)

/** Quanto da velocidade sobra numa colisão entre bolas. */
export const BALL_RESTITUTION: Fixed = F.from(0.95)

/**
 * Quanto do efeito vertical vira velocidade no contato.
 *
 * Calibrado para dar controle de posição perceptível sem virar teleporte.
 */
export const SPIN_TRANSFER: Fixed = F.from(0.6)

/** Quanto do efeito sobra depois de ser usado num contato. */
export const SPIN_RETENTION: Fixed = F.from(0.35)

/** Quanto o efeito lateral desvia a saída da tabela. */
export const SPIN_CUSHION_EFFECT: Fixed = F.from(0.35)

/** Perda de efeito por passo, pelo atrito do pano. */
export const SPIN_DECAY: Fixed = F.from(0.995)

/** Passo de integração: 1/240s. */
export const DT: Fixed = F.div(F.ONE, F.fromInt(240))

/**
 * Teto de passos por tacada.
 *
 * Sem ele, um bug de física viraria laço infinito no servidor. 240 passos por
 * segundo × 60 segundos é muito mais do que qualquer tacada real precisa.
 */
export const MAX_STEPS = 240 * 60

// ------------------------------------------------------------- caçapas

export type Pocket = { center: Vec; kind: 'corner' | 'side' }

/**
 * As seis caçapas: quatro nos cantos, duas no meio das tabelas longas.
 *
 * Ficam ligeiramente para fora do retângulo de jogo, como numa mesa real —
 * a boca da caçapa avança sobre o canto.
 */
export const POCKETS: readonly Pocket[] = [
  { center: V.vec(0, 0), kind: 'corner' },
  { center: V.vec(F.div(WIDTH, F.fromInt(2)), 0), kind: 'side' },
  { center: V.vec(WIDTH, 0), kind: 'corner' },
  { center: V.vec(0, HEIGHT), kind: 'corner' },
  { center: V.vec(F.div(WIDTH, F.fromInt(2)), HEIGHT), kind: 'side' },
  { center: V.vec(WIDTH, HEIGHT), kind: 'corner' },
]

/** Índice da caçapa que capturou a bola, ou -1. */
export function pocketAt(position: Vec): number {
  for (let i = 0; i < POCKETS.length; i++) {
    if (V.distanceSq(position, POCKETS[i]!.center) <= POCKET_RADIUS_SQ) return i
  }
  return -1
}

// -------------------------------------------------------------- tabelas

/** Lados da mesa, na ordem: esquerda, direita, baixo, cima. */
export const enum Cushion {
  Left = 0,
  Right = 1,
  Bottom = 2,
  Top = 3,
}

/** Normal apontando para dentro da mesa. */
export const CUSHION_NORMALS: readonly Vec[] = [
  V.vec(F.ONE, 0),
  V.vec(-F.ONE, 0),
  V.vec(0, F.ONE),
  V.vec(0, -F.ONE),
]

/** Limites que o CENTRO da bola pode alcançar antes de tocar cada tabela. */
export const CUSHION_BOUNDS = {
  minX: BALL_RADIUS,
  maxX: WIDTH - BALL_RADIUS,
  minY: BALL_RADIUS,
  maxY: HEIGHT - BALL_RADIUS,
} as const

/** Posição está dentro da área jogável, considerando o raio da bola? */
export function isInsideBounds(position: Vec): boolean {
  return (
    position.x >= CUSHION_BOUNDS.minX &&
    position.x <= CUSHION_BOUNDS.maxX &&
    position.y >= CUSHION_BOUNDS.minY &&
    position.y <= CUSHION_BOUNDS.maxY
  )
}

// ---------------------------------------------------- posições iniciais

/** Linha da cabeça: onde a branca é colocada no saque. */
export const HEAD_STRING_X: Fixed = F.div(WIDTH, F.fromInt(4))

/** Ponto de pé: vértice do triângulo. */
export const FOOT_SPOT: Vec = V.vec(
  F.mul(WIDTH, F.from(0.75)),
  F.div(HEIGHT, F.fromInt(2)),
)

export const CUE_SPOT: Vec = V.vec(HEAD_STRING_X, F.div(HEIGHT, F.fromInt(2)))
