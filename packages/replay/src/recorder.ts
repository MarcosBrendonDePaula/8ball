import {
  ENGINE_VERSION,
  clampCue,
  type CueParams,
  DEFAULT_CUE,
} from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'
import {
  MAX_DECISIONS,
  MAX_SHOTS,
  REPLAY_VERSION,
  decodeAngle,
  decodePower,
  decodeSpin,
  encodeAngle,
  encodePower,
  encodeSpin,
  encodeReplay,
  replaySize,
  type EncodedShot,
  type Replay,
} from './format'

/**
 * Gravador de partida.
 *
 * O ponto que faz isto funcionar não é guardar as tacadas — é QUANTIZAR ANTES
 * DE JOGAR. A interface produz um ângulo com toda a precisão do mouse; se ele
 * fosse simulado como veio e só arredondado na hora de gravar, o replay
 * reproduziria uma partida ligeiramente diferente da que aconteceu. Numa mesa
 * de sinuca, "ligeiramente diferente" vira outra bola encaçapada em três
 * tacadas, e o vencedor gravado não bate com o simulado.
 *
 * Então `quantize()` é chamado primeiro, e é o valor de volta — já passado pela
 * grade de u16/u8/i8 — que a física recebe. O replay não é um registro do que
 * foi jogado: é a mesma entrada, guardada.
 */

/** Tacada como a física a recebe, depois de passar pela grade. */
export type QuantizedShot = {
  /** Já em radianos, mas apenas num dos 65.536 valores representáveis. */
  angle: number
  power: number
  spin: { x: number; y: number }
  /** Como estes mesmos valores vão para os bytes. */
  encoded: EncodedShot
}

/**
 * Encaixa a tacada na grade do formato.
 *
 * Chame isto ANTES de simular e use o resultado. Usar a entrada original e
 * gravar a quantizada é o erro que este módulo existe para impedir.
 */
export function quantize(
  angle: number,
  power: number,
  spin: { x: number; y: number } = { x: 0, y: 0 },
): QuantizedShot {
  const encoded: EncodedShot = {
    angle: encodeAngle(angle),
    power: encodePower(power),
    spinX: encodeSpin(spin.x),
    spinY: encodeSpin(spin.y),
  }

  return {
    angle: decodeAngle(encoded.angle),
    power: decodePower(encoded.power),
    spin: { x: decodeSpin(encoded.spinX), y: decodeSpin(encoded.spinY) },
    encoded,
  }
}

export class ReplayFullError extends Error {
  constructor(limite: number) {
    super(`Partida passou de ${limite} tacadas; o replay não cabe na transação.`)
    this.name = 'ReplayFullError'
  }
}

export class ShotRecorder {
  readonly seed: Uint8Array
  readonly mode: GameModeId
  readonly cues: [CueParams, CueParams]

  #shots: EncodedShot[] = []
  #decisions: number[] = []

  /**
   * @param seed  os 32 bytes do commit-reveal que definiram a quebra
   * @param cues  o taco de cada jogador, já preso aos limites válidos
   */
  constructor(mode: GameModeId, seed: Uint8Array, cues?: [CueParams, CueParams]) {
    if (seed.length !== 32) {
      throw new Error(`Seed da partida deve ter 32 bytes, veio com ${seed.length}.`)
    }

    this.mode = mode
    // Cópia: se quem chamou reaproveitar o buffer, o replay não muda embaixo.
    this.seed = seed.slice()
    this.cues = [
      clampCue(cues?.[0] ?? DEFAULT_CUE),
      clampCue(cues?.[1] ?? DEFAULT_CUE),
    ]
  }

  get shotCount(): number {
    return this.#shots.length
  }

  get decisionCount(): number {
    return this.#decisions.length
  }

  /** Tamanho atual em bytes, para a interface avisar antes de estourar. */
  get byteSize(): number {
    return replaySize(this.#shots.length, this.#decisions.length)
  }

  /** Quantas tacadas ainda cabem. */
  get remaining(): number {
    return MAX_SHOTS - this.#shots.length
  }

  /**
   * Registra uma tacada já quantizada.
   *
   * Recusa em vez de descartar em silêncio: uma partida truncada produziria um
   * replay que verifica sem erro e aponta o vencedor errado, que é o pior
   * resultado possível para uma auditoria.
   */
  record(shot: QuantizedShot | EncodedShot): void {
    if (this.#shots.length >= MAX_SHOTS) throw new ReplayFullError(MAX_SHOTS)
    this.#shots.push('encoded' in shot ? shot.encoded : shot)
  }

  /**
   * Registra a escolha do jogador numa decisão aberta pelas regras.
   *
   * Só o ÍNDICE da opção é guardado. Quando a decisão acontece é dedutível das
   * regras, então gravar o momento seria redundante — e redundância num formato
   * binário é uma oportunidade a mais de os dois lados discordarem.
   */
  recordDecision(optionIndex: number): void {
    if (this.#decisions.length >= MAX_DECISIONS) {
      throw new ReplayFullError(MAX_DECISIONS)
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 255) {
      throw new Error(`Índice de decisão inválido: ${optionIndex}.`)
    }
    this.#decisions.push(optionIndex)
  }

  /** Atalho: quantiza, registra e devolve o que a física deve usar. */
  take(
    angle: number,
    power: number,
    spin?: { x: number; y: number },
  ): QuantizedShot {
    const quantizada = quantize(angle, power, spin)
    this.record(quantizada)
    return quantizada
  }

  /** O replay como está agora. Pode ser chamado a qualquer momento. */
  build(): Replay {
    return {
      version: REPLAY_VERSION,
      mode: this.mode,
      // Carimba a física DESTA execução. É o que permite a alguém, anos
      // depois, saber com qual comportamento reproduzir estes bytes.
      engineVersion: ENGINE_VERSION,
      seed: this.seed.slice(),
      cues: [{ ...this.cues[0] }, { ...this.cues[1] }],
      shots: this.#shots.map((s) => ({ ...s })),
      decisions: [...this.#decisions],
    }
  }

  /** Os bytes que vão para a blockchain. */
  toBytes(): Uint8Array {
    return encodeReplay(this.build())
  }
}
