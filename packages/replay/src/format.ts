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

export const REPLAY_VERSION = 5

/**
 * Versões que este código ainda sabe LER.
 *
 * Gravar acontece sempre na versão corrente; ler precisa alcançar o passado,
 * senão cada mudança de formato órfã todo o histórico já gravado — e a
 * promessa de auditoria "para sempre" vale só até o próximo bump.
 *
 * Ler não basta: reproduzir um replay antigo exige as SEMÂNTICAS da época. Um
 * replay v4 não tem caçapa declarada porque o jogo daquele momento não
 * declarava, e as regras julgavam com `called = null` — produzindo faltas
 * `no-call` legítimas. Verificá-lo exigindo declaração daria outro resultado.
 */
export const READABLE_VERSIONS = [3, 4, 5] as const

/** Cabeçalho fixo, em bytes. */
export const HEADER_SIZE = 60

/**
 * Cabeçalho de cada versão legível.
 *
 * O v3 tinha 58 bytes; o v4 cresceu para 60 ao ganhar a contagem de
 * posicionamentos. O v4 e o v5 são idênticos no layout — no v4 o byte 59 era
 * reservado e valia zero, que é exatamente "nenhuma declaração".
 */
const HEADER_BY_VERSION: Record<number, number> = { 3: 58, 4: 60, 5: 60 }

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

/** Cada posicionamento: x u16, y u16, sobre as dimensões da mesa. */
export const PLACEMENT_SIZE = 4

/**
 * Teto de posicionamentos de bola na mão.
 *
 * No PIOR caso, toda tacada é falta e cada uma abre uma bola na mão — o teto
 * seguro seria igual ao de tacadas, e aí cada tacada custaria 9 bytes em vez
 * de 5, derrubando o limite para ~65 tacadas.
 *
 * 45 em 80 tacadas é o meio-termo: cobre uma partida ruim de verdade e ainda
 * deixa folga no orçamento. Uma partida com mais de 45 faltas não cabe, e o
 * gravador ERRA em vez de truncar — um replay truncado verifica sem reclamar e
 * aponta o vencedor errado, que é o pior desfecho possível.
 */
export const MAX_PLACEMENTS = 45

/** Cada declaração: bola u8, caçapa u8. */
export const CALL_SIZE = 2

/**
 * Teto de declarações de caçapa.
 *
 * Com a regra padrão (`eight-only`), só a bola 8 exige declarar — uma ou duas
 * por partida. Oito é folgado e barato.
 */
export const MAX_CALLS = 8

/**
 * Teto de tacadas por replay.
 *
 * Cabe no orçamento acima com folga para uma instrução de compute budget, que
 * é comum precisar acrescentar. Uma partida de 8-Ball costuma ter menos de 30
 * tacadas, então 80 é generoso — e cada tacada custa cinco vezes mais que uma
 * decisão, então é daqui que sai o espaço para gravar bola na mão.
 *
 * O limite é explícito, e estourar dá erro, em vez de o encode truncar o fim
 * em silêncio: um replay truncado verifica sem reclamar e aponta o vencedor
 * errado — o pior desfecho possível para uma auditoria.
 */
export const MAX_SHOTS = 80

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
export const MAX_REPLAY_BYTES =
  HEADER_SIZE +
  MAX_SHOTS * SHOT_SIZE +
  MAX_DECISIONS +
  MAX_PLACEMENTS * PLACEMENT_SIZE +
  MAX_CALLS * CALL_SIZE

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
  /**
   * Onde a branca foi colocada, a cada bola na mão, na ordem.
   *
   * Em metros, já dentro dos limites da mesa. O encode quantiza para u16 por
   * eixo — e, como toda entrada do jogador, é o valor QUANTIZADO que a física
   * precisa receber, não o original.
   */
  placements: { x: number; y: number }[]
  /**
   * Bola e caçapa declaradas, na ordem em que as regras as exigiram.
   *
   * A WPA manda declarar antes de jogar na bola 8; sem isso, encaçapá-la é
   * falta — e falta na 8 é derrota. É entrada do jogador como qualquer outra,
   * e por isso vai gravada.
   */
  calls: { ball: number; pocket: number }[]
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

/**
 * Dimensões da mesa, para quantizar a posição da bola na mão.
 *
 * Repetidas aqui em vez de importadas de `table.ts` de propósito: o formato do
 * replay precisa ser estável POR VERSÃO, e a geometria pertence à versão da
 * física. Se a mesa mudar de tamanho numa física v3, os replays v4 antigos
 * continuam sendo lidos com estas medidas — que são as que valiam quando eles
 * foram gravados.
 */
export const TABLE_WIDTH_M = 1.98
export const TABLE_HEIGHT_M = 0.99

const quantizar = (valor: number, extensao: number): number =>
  Math.max(0, Math.min(65535, Math.round((valor / extensao) * 65535)))

const desquantizar = (bruto: number, extensao: number): number => (bruto / 65535) * extensao

export const encodePlacement = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: quantizar(p.x, TABLE_WIDTH_M),
  y: quantizar(p.y, TABLE_HEIGHT_M),
})

export const decodePlacement = (b: { x: number; y: number }): { x: number; y: number } => ({
  x: desquantizar(b.x, TABLE_WIDTH_M),
  y: desquantizar(b.y, TABLE_HEIGHT_M),
})

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

  const placements = replay.placements ?? []
  if (placements.length > MAX_PLACEMENTS) {
    throw new ReplayFormatError(
      `Replay com ${placements.length} posicionamentos passa do limite de ${MAX_PLACEMENTS}.`,
    )
  }

  const calls = replay.calls ?? []
  if (calls.length > MAX_CALLS) {
    throw new ReplayFormatError(
      `Replay com ${calls.length} declarações passa do limite de ${MAX_CALLS}.`,
    )
  }

  const bytes = new Uint8Array(
    HEADER_SIZE +
      replay.shots.length * SHOT_SIZE +
      decisions.length +
      placements.length * PLACEMENT_SIZE +
      calls.length * CALL_SIZE,
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
  bytes[58] = placements.length
  bytes[59] = calls.length

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

  for (const p of placements) {
    const q = encodePlacement(p)
    view.setUint16(offset, q.x, true)
    view.setUint16(offset + 2, q.y, true)
    offset += PLACEMENT_SIZE
  }

  for (const c of calls) {
    bytes[offset] = c.ball & 0xff
    bytes[offset + 1] = c.pocket & 0xff
    offset += CALL_SIZE
  }

  return bytes
}

export function decodeReplay(bytes: Uint8Array): Replay {
  // O menor cabeçalho entre as versões legíveis; o exato sai da versão.
  if (bytes.length < 58) {
    throw new ReplayFormatError(`Replay truncado: ${bytes.length} bytes.`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const version = bytes[0]!
  const header = HEADER_BY_VERSION[version]
  if (header === undefined) {
    // Recusa em vez de adivinhar: campos de uma versão desconhecida podem
    // significar outra coisa, e chutar produziria um replay errado que parece
    // certo. As conhecidas estão em READABLE_VERSIONS.
    throw new ReplayFormatError(
      `Versão de replay não suportada: ${version}. ` +
        `Este código lê as versões ${READABLE_VERSIONS.join(', ')}.`,
    )
  }

  const mode = MODE_BY_CODE[bytes[1]!]
  if (!mode) throw new ReplayFormatError(`Modalidade desconhecida: ${bytes[1]}.`)

  const engineVersion = bytes[2]!
  const nDecisoes = bytes[3]!
  // O v3 não tinha nenhum dos dois campos; os bytes 58 e 59 já eram tacada.
  const nPosicoes = header >= 60 ? bytes[58]! : 0
  const nDeclaracoes = header >= 60 ? bytes[59]! : 0
  const seed = bytes.slice(4, 36)
  const cues: [CueParams, CueParams] = [lerTaco(view, 36), lerTaco(view, 46)]

  const total = view.getUint16(56, true)
  const esperado =
    header + total * SHOT_SIZE + nDecisoes + nPosicoes * PLACEMENT_SIZE + nDeclaracoes * CALL_SIZE
  if (bytes.length !== esperado) {
    throw new ReplayFormatError(
      `Replay diz ter ${total} tacadas, ${nDecisoes} decisões, ${nPosicoes} ` +
        `posicionamentos e ${nDeclaracoes} declarações (${esperado} bytes) ` +
        `mas tem ${bytes.length}.`,
    )
  }

  const shots: EncodedShot[] = []
  for (let i = 0; i < total; i++) {
    const offset = header + i * SHOT_SIZE
    shots.push({
      angle: view.getUint16(offset, true),
      power: view.getUint8(offset + 2),
      spinX: view.getInt8(offset + 3),
      spinY: view.getInt8(offset + 4),
    })
  }

  const inicioDecisoes = header + total * SHOT_SIZE
  const decisions = Array.from(bytes.slice(inicioDecisoes, inicioDecisoes + nDecisoes))

  const inicioPosicoes = inicioDecisoes + nDecisoes
  const placements: { x: number; y: number }[] = []
  for (let i = 0; i < nPosicoes; i++) {
    const o = inicioPosicoes + i * PLACEMENT_SIZE
    placements.push(
      decodePlacement({ x: view.getUint16(o, true), y: view.getUint16(o + 2, true) }),
    )
  }

  const inicioDeclaracoes = inicioPosicoes + nPosicoes * PLACEMENT_SIZE
  const calls: { ball: number; pocket: number }[] = []
  for (let i = 0; i < nDeclaracoes; i++) {
    const o = inicioDeclaracoes + i * CALL_SIZE
    calls.push({ ball: bytes[o]!, pocket: bytes[o + 1]! })
  }

  return { version, mode, engineVersion, seed, cues, shots, decisions, placements, calls }
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
export const replaySize = (
  shotCount: number,
  decisionCount = 0,
  placementCount = 0,
  callCount = 0,
): number =>
  HEADER_SIZE +
  shotCount * SHOT_SIZE +
  decisionCount +
  placementCount * PLACEMENT_SIZE +
  callCount * CALL_SIZE
