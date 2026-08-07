import type { CueParams } from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'

/**
 * Formato binário do replay.
 *
 * O objetivo é caber numa transação da Solana, para a partida ficar auditável
 * PARA SEMPRE em vez de enquanto o nosso servidor existir. O limite prático de
 * dados por transação é de ~900 bytes; uma partida de 60 tacadas ocupa ~355.
 *
 * DECISÃO CENTRAL — a tacada é quantizada NA ORIGEM, não na gravação.
 *
 * O jogador não envia um ângulo de precisão infinita que depois é arredondado
 * para caber: ele envia um `u16`, e é esse valor que a engine simula. Se a
 * quantização acontecesse só ao gravar, o replay reproduziria uma partida
 * ligeiramente diferente da que foi jogada — e o hash não bateria.
 *
 * Resolução escolhida:
 *   ângulo  u16 → 65.536 direções (a melhor grade de taco tem ~1.400)
 *   força   u8  → 256 níveis, imperceptível na mesa
 *   efeito  i8  → 255 níveis por eixo
 *
 * Layout:
 *   0       versão do FORMATO destes bytes
 *   1       modalidade
 *   2       versão da FÍSICA que gerou a partida
 *   3       reservado
 *   4..35   seed da quebra (32 bytes)
 *   36..45  taco do jogador 0 (5 × u16)
 *   46..55  taco do jogador 1
 *   56..57  número de tacadas (u16)
 *   58..    tacadas, 5 bytes cada
 *
 * As duas versões são distintas e ambas precisam estar aqui. A do formato diz
 * como LER os bytes; a da física diz com qual COMPORTAMENTO reproduzi-los. Um
 * replay sem a segunda seria reproduzido pela física de hoje e poderia apontar
 * outro vencedor — o que destruiria a auditoria em silêncio.
 */

export const REPLAY_VERSION = 2

/** Cabeçalho fixo, em bytes. */
export const HEADER_SIZE = 58

/** Cada tacada: ângulo u16, força u8, efeito i8 × 2. */
export const SHOT_SIZE = 5

/**
 * Teto de tacadas por replay.
 *
 * Escolhido para o replay caber numa transação com folga para assinaturas e
 * contas. Partida mais longa que isso é rara, e o limite é explícito em vez de
 * o encode falhar silenciosamente truncando o fim.
 */
export const MAX_SHOTS = 160

export const MAX_REPLAY_BYTES = HEADER_SIZE + MAX_SHOTS * SHOT_SIZE

const MODE_CODES: Record<GameModeId, number> = { eightball: 0, sinuca: 1 }
const MODE_BY_CODE: Record<number, GameModeId> = { 0: 'eightball', 1: 'sinuca' }

/**
 * Tacada no formato canônico.
 *
 * São estes valores — inteiros pequenos — que trafegam, que a engine simula e
 * que ficam gravados. Não existe versão "de maior precisão" em lugar nenhum.
 */
export type EncodedShot = {
  /** 0..65535, mapeado para 0..2π. */
  angle: number
  /** 0..255, mapeado para 0..1. */
  power: number
  /** -127..127, mapeado para -1..1. */
  spinX: number
  spinY: number
}

export type Replay = {
  version: number
  mode: GameModeId
  /** Versão da física com que a partida foi jogada. */
  engineVersion: number
  seed: Uint8Array
  /** Atributos do taco de cada jogador durante a partida. */
  cues: [CueParams, CueParams]
  shots: EncodedShot[]
}

export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayFormatError'
  }
}

// ------------------------------------------------------------ conversões

/** Ângulo em radianos → u16. Envolve a volta, então nunca estoura. */
export function encodeAngle(radians: number): number {
  const volta = Math.PI * 2
  const normalizado = ((radians % volta) + volta) % volta
  return Math.round((normalizado / volta) * 65536) % 65536
}

export const decodeAngle = (value: number): number => (value / 65536) * Math.PI * 2

/** Força 0..1 → u8. */
export const encodePower = (power: number): number =>
  Math.max(0, Math.min(255, Math.round(power * 255)))

export const decodePower = (value: number): number => value / 255

/** Efeito -1..1 → i8. */
export const encodeSpin = (spin: number): number =>
  Math.max(-127, Math.min(127, Math.round(spin * 127)))

export const decodeSpin = (value: number): number => value / 127

// -------------------------------------------------------------- serialização

export function encodeReplay(replay: Replay): Uint8Array {
  if (replay.seed.length !== 32) {
    throw new ReplayFormatError(`Seed deve ter 32 bytes, veio com ${replay.seed.length}.`)
  }
  if (replay.shots.length > MAX_SHOTS) {
    throw new ReplayFormatError(
      `Replay com ${replay.shots.length} tacadas passa do limite de ${MAX_SHOTS}.`,
    )
  }

  const bytes = new Uint8Array(HEADER_SIZE + replay.shots.length * SHOT_SIZE)
  const view = new DataView(bytes.buffer)

  bytes[0] = replay.version
  bytes[1] = MODE_CODES[replay.mode]
  bytes[2] = replay.engineVersion
  bytes[3] = 0 // reservado
  bytes.set(replay.seed, 4)

  escreverTaco(view, 36, replay.cues[0])
  escreverTaco(view, 46, replay.cues[1])

  view.setUint16(56, replay.shots.length, true)

  let offset = HEADER_SIZE
  for (const shot of replay.shots) {
    view.setUint16(offset, shot.angle, true)
    view.setUint8(offset + 2, shot.power)
    view.setInt8(offset + 3, shot.spinX)
    view.setInt8(offset + 4, shot.spinY)
    offset += SHOT_SIZE
  }

  return bytes
}

export function decodeReplay(bytes: Uint8Array): Replay {
  if (bytes.length < HEADER_SIZE) {
    throw new ReplayFormatError(`Replay truncado: ${bytes.length} bytes.`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const version = bytes[0]!
  if (version !== REPLAY_VERSION) {
    // Recusa em vez de tentar interpretar: campos de outra versão podem
    // significar outra coisa, e adivinhar produziria um replay errado que
    // parece certo.
    throw new ReplayFormatError(`Versão de replay não suportada: ${version}.`)
  }

  const mode = MODE_BY_CODE[bytes[1]!]
  if (!mode) throw new ReplayFormatError(`Modalidade desconhecida: ${bytes[1]}.`)

  const engineVersion = bytes[2]!
  const seed = bytes.slice(4, 36)
  const cues: [CueParams, CueParams] = [lerTaco(view, 36), lerTaco(view, 46)]

  const total = view.getUint16(56, true)
  const esperado = HEADER_SIZE + total * SHOT_SIZE
  if (bytes.length !== esperado) {
    throw new ReplayFormatError(
      `Replay diz ter ${total} tacadas (${esperado} bytes) mas tem ${bytes.length}.`,
    )
  }

  const shots: EncodedShot[] = []
  for (let i = 0; i < total; i++) {
    const offset = HEADER_SIZE + i * SHOT_SIZE
    shots.push({
      angle: view.getUint16(offset, true),
      power: view.getUint8(offset + 2),
      spinX: view.getInt8(offset + 3),
      spinY: view.getInt8(offset + 4),
    })
  }

  return { version, mode, engineVersion, seed, cues, shots }
}

function escreverTaco(view: DataView, offset: number, cue: CueParams): void {
  view.setUint16(offset, cue.massBps, true)
  view.setUint16(offset + 2, cue.spinBps, true)
  view.setUint16(offset + 4, cue.aimBps, true)
  view.setUint16(offset + 6, cue.clothGripBps, true)
  view.setUint16(offset + 8, cue.breakBonusBps, true)
}

function lerTaco(view: DataView, offset: number): CueParams {
  return {
    massBps: view.getUint16(offset, true),
    spinBps: view.getUint16(offset + 2, true),
    aimBps: view.getUint16(offset + 4, true),
    clothGripBps: view.getUint16(offset + 6, true),
    breakBonusBps: view.getUint16(offset + 8, true),
  }
}

/** Tamanho que o replay terá, sem serializar. */
export const replaySize = (shotCount: number): number => HEADER_SIZE + shotCount * SHOT_SIZE
