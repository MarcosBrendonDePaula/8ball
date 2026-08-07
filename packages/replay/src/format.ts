import type { CueParams } from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'

/**
 * Formato binário do replay.
 *
 * O objetivo é caber numa transação da Solana, para a partida ficar auditável
 * PARA SEMPRE em vez de enquanto o nosso servidor existir.
 *
 * O orçamento é apertado e foi MEDIDO, não estimado: a transação inteira não
 * pode passar de 1232 bytes, e um `settle_match` sem replay nenhum já gasta
 * 510 com assinaturas, contas e discriminador. Sobram 721 bytes para o replay.
 * A estimativa anterior de "~900" era otimista e teria feito partidas longas
 * falharem na liquidação, com dinheiro na mesa.
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
 *   3       número de decisões (u8)
 *   4..35   seed da quebra (32 bytes)
 *   36..45  taco do jogador 0 (5 × u16)
 *   46..55  taco do jogador 1
 *   56..57  número de tacadas (u16)
 *   58..    tacadas, 5 bytes cada
 *   depois  decisões, 1 byte cada
 *
 * As duas versões são distintas e ambas precisam estar aqui. A do formato diz
 * como LER os bytes; a da física diz com qual COMPORTAMENTO reproduzi-los. Um
 * replay sem a segunda seria reproduzido pela física de hoje e poderia apontar
 * outro vencedor — o que destruiria a auditoria em silêncio.
 *
 * DECISÕES — tacada não é a única entrada do jogador.
 *
 * O 8-Ball dá escolhas ao adversário depois de uma quebra irregular, e uma
 * delas manda armar o rack de novo. Sem gravá-las, o replay de qualquer partida
 * que passasse por essa situação reproduziria outra coisa. Elas entram como uma
 * lista de índices de opção, consumida na ordem em que as regras as abrem — o
 * verificador sabe QUANDO uma decisão acontece, então basta gravar QUAL foi.
 */

export const REPLAY_VERSION = 3

/** Cabeçalho fixo, em bytes. */
export const HEADER_SIZE = 58

/** Cada tacada: ângulo u16, força u8, efeito i8 × 2. */
export const SHOT_SIZE = 5

/**
 * Espaço disponível para o replay dentro de uma transação de liquidação.
 *
 * Medido contra `settleMatchIx` real, não deduzido. Se a instrução ganhar mais
 * uma conta, este número cai — e o teste que o compara com `MAX_REPLAY_BYTES`
 * é o que avisa.
 */
export const TX_REPLAY_BUDGET = 721

/**
 * Teto de tacadas por replay.
 *
 * Cabe no orçamento acima com folga para uma instrução de compute budget, que
 * é comum precisar acrescentar. Uma partida de 8-Ball costuma ter menos de 30
 * tacadas, então 120 é generoso.
 *
 * O limite é explícito, e estourar dá erro, em vez de o encode truncar o fim
 * em silêncio: um replay truncado verifica sem reclamar e aponta o vencedor
 * errado — o pior desfecho possível para uma auditoria.
 */
export const MAX_SHOTS = 120

/**
 * Teto de decisões por replay.
 *
 * Generoso de propósito: na prática são zero ou uma. Cada rerack repete a
 * quebra, então uma partida patológica poderia encadear algumas.
 */
export const MAX_DECISIONS = 24

/**
 * Maior replay possível, em bytes.
 *
 * Casado com `MAX_REPLAY_BYTES` do programa on-chain. Se os dois divergirem, a
 * liquidação falha só nas partidas longas — o pior tipo de bug, porque passa em
 * todo teste curto e aparece em produção com dinheiro na mesa.
 */
export const MAX_REPLAY_BYTES = HEADER_SIZE + MAX_SHOTS * SHOT_SIZE + MAX_DECISIONS

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
  /**
   * Escolhas do jogador, na ordem em que as regras as abriram.
   *
   * Cada valor é o índice da opção em `PendingDecision.options`. Vazio na
   * imensa maioria das partidas.
   */
  decisions: number[]
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

  const decisions = replay.decisions ?? []
  if (decisions.length > MAX_DECISIONS) {
    throw new ReplayFormatError(
      `Replay com ${decisions.length} decisões passa do limite de ${MAX_DECISIONS}.`,
    )
  }
  for (const escolha of decisions) {
    if (!Number.isInteger(escolha) || escolha < 0 || escolha > 255) {
      throw new ReplayFormatError(`Índice de decisão inválido: ${escolha}.`)
    }
  }

  const bytes = new Uint8Array(
    HEADER_SIZE + replay.shots.length * SHOT_SIZE + decisions.length,
  )
  const view = new DataView(bytes.buffer)

  bytes[0] = replay.version
  bytes[1] = MODE_CODES[replay.mode]
  bytes[2] = replay.engineVersion
  bytes[3] = decisions.length
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

  for (const escolha of decisions) {
    bytes[offset] = escolha
    offset++
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
  const nDecisoes = bytes[3]!
  const seed = bytes.slice(4, 36)
  const cues: [CueParams, CueParams] = [lerTaco(view, 36), lerTaco(view, 46)]

  const total = view.getUint16(56, true)
  const esperado = HEADER_SIZE + total * SHOT_SIZE + nDecisoes
  if (bytes.length !== esperado) {
    throw new ReplayFormatError(
      `Replay diz ter ${total} tacadas e ${nDecisoes} decisões ` +
        `(${esperado} bytes) mas tem ${bytes.length}.`,
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

  const inicioDecisoes = HEADER_SIZE + total * SHOT_SIZE
  const decisions = Array.from(bytes.slice(inicioDecisoes, inicioDecisoes + nDecisoes))

  return { version, mode, engineVersion, seed, cues, shots, decisions }
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
export const replaySize = (shotCount: number, decisionCount = 0): number =>
  HEADER_SIZE + shotCount * SHOT_SIZE + decisionCount
