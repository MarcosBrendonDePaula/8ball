import { sha256 } from '@noble/hashes/sha2.js'
import {
  ENGINE_VERSION,
  PHYSICS_DIGEST,
  applyShot,
  clampCue,
  fixturesDigest,
  fixed as F,
  hashState,
  jitterFromSeed,
  rackBalls,
  table as T,
  vec as V,
  CUE_BALL,
  type TableState,
} from '@zinc-pool/engine-physics'
import { getGameMode } from '@zinc-pool/engine-rules'
import {
  decodeAngle,
  decodePower,
  decodeSpin,
  encodeReplay,
  type Replay,
} from './format'

/**
 * Verificação de replay.
 *
 * É o que torna o resultado auditável sem confiar em ninguém: qualquer pessoa
 * pega os bytes gravados na blockchain, roda esta função, e confere se o
 * vencedor declarado bate com o que a simulação produz.
 *
 * O código é o mesmo que o jogo usa em tempo real. Não existe "engine de
 * verificação" separada — se existisse, a verificação poderia divergir do jogo
 * e a auditoria não provaria nada.
 */

export type VerificationResult = {
  /** Vencedor segundo a simulação, ou null se a partida não terminou. */
  winner: 0 | 1 | null
  /** Hash do estado final da mesa. */
  stateHash: string
  /** Hash SHA-256 dos bytes do replay — é este que vai on-chain. */
  replayHash: Uint8Array
  /** Quantas tacadas foram efetivamente aplicadas. */
  shotsApplied: number
  /** Motivo de a verificação ter parado antes do fim, se parou. */
  stoppedBecause: string | null
}

/**
 * Confere se esta cópia da engine reproduz a física que gravou o replay.
 *
 * Duas checagens independentes, e as duas importam:
 *
 *   - a VERSÃO declarada no replay bate com a desta engine
 *   - a IMPRESSÃO DIGITAL da física calculada bate com a declarada
 *
 * A segunda pega o caso perigoso: alguém alterou a física sem incrementar a
 * versão. Sem ela, uma engine adulterada verificaria replays antigos com
 * regras novas e apontaria outro vencedor, parecendo legítima.
 */
export function checkEngineCompatibility(engineVersion: number): {
  compatible: boolean
  reason: string | null
} {
  if (engineVersion !== ENGINE_VERSION) {
    return {
      compatible: false,
      reason:
        `Replay gravado com a física v${engineVersion}; esta engine é v${ENGINE_VERSION}. ` +
        'Use a versão correspondente para verificar.',
    }
  }

  const digest = fixturesDigest()
  if (digest !== PHYSICS_DIGEST) {
    return {
      compatible: false,
      reason:
        `Esta engine não reproduz a física v${ENGINE_VERSION}: ` +
        `impressão digital ${digest}, esperada ${PHYSICS_DIGEST}. A cópia foi alterada.`,
    }
  }

  return { compatible: true, reason: null }
}

/**
 * Reproduz o replay do zero e devolve o resultado.
 *
 * Não recebe nada além dos bytes: seed, tacos e tacadas estão todos lá. É essa
 * autossuficiência que permite alguém verificar daqui a anos, com o site fora
 * do ar.
 */
export function verifyReplay(replay: Replay): VerificationResult {
  const compatibilidade = checkEngineCompatibility(replay.engineVersion)
  if (!compatibilidade.compatible) {
    throw new Error(compatibilidade.reason ?? 'Engine incompatível com este replay.')
  }

  const mode = getGameMode(replay.mode)

  const table = rackBalls(jitterFromSeed(replay.seed))
  let rules = mode.create(0)

  let aplicadas = 0
  let parou: string | null = null

  for (const shot of replay.shots) {
    const resumo = mode.summarize(rules as never)
    if (resumo.finished) {
      parou = 'a partida já havia terminado'
      break
    }

    // O taco é o do jogador da VEZ — cada um joga com o seu.
    const cue = clampCue(replay.cues[resumo.turn])

    reposicionarBrancaSeNecessario(table)

    const resultado = applyShot(table, {
      intent: {
        angle: F.from(decodeAngle(shot.angle)),
        power: F.from(decodePower(shot.power)),
        spin: { x: F.from(decodeSpin(shot.spinX)), y: F.from(decodeSpin(shot.spinY)) },
      },
      cue,
      isBreak: aplicadas === 0,
    })

    const outcome = outcomeFromResult(resultado.events)
    rules = mode.play(rules as never, outcome as never).state
    aplicadas++
  }

  const resumoFinal = mode.summarize(rules as never)

  return {
    winner: resumoFinal.winner,
    stateHash: hashState(table),
    replayHash: sha256(encodeReplay(replay)),
    shotsApplied: aplicadas,
    stoppedBecause: parou,
  }
}

/** Compara o replay com o resultado que foi declarado on-chain. */
export function replayProves(
  replay: Replay,
  declared: { winner: 0 | 1; resultHash: Uint8Array },
): { valid: boolean; reason: string | null } {
  const resultado = verifyReplay(replay)

  if (resultado.winner === null) {
    return { valid: false, reason: 'O replay não chega a um vencedor.' }
  }
  if (resultado.winner !== declared.winner) {
    return {
      valid: false,
      reason: `O replay dá vitória ao jogador ${resultado.winner + 1}, não ao declarado.`,
    }
  }
  if (!mesmosBytes(resultado.replayHash, declared.resultHash)) {
    return { valid: false, reason: 'O hash do replay não bate com o gravado on-chain.' }
  }

  return { valid: true, reason: null }
}

const mesmosBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * A branca encaçapada volta ao ponto de saque antes da próxima tacada.
 *
 * Regra simplificada de propósito: a posição de bola na mão escolhida pelo
 * jogador precisaria estar gravada no replay para ser reproduzível. Enquanto
 * ela não estiver, o replay usa a posição canônica — e a verificação só é
 * válida para partidas em que ninguém moveu a branca.
 */
function reposicionarBrancaSeNecessario(table: TableState): void {
  const branca = table.balls.find((b) => b.id === CUE_BALL)
  if (!branca?.pocketed) return

  branca.pocketed = false
  V.copy(branca.position, T.CUE_SPOT)
  V.set(branca.velocity, 0, 0)
  V.set(branca.spin, 0, 0)
}

/** Mesma tradução que o cliente faz, para os dois julgarem igual. */
function outcomeFromResult(events: readonly { type: string; [k: string]: unknown }[]) {
  let firstContact: number | null = null
  let contactIndex = -1

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.type !== 'ball-ball') continue
    const a = e.a as number
    const b = e.b as number
    if (a !== CUE_BALL && b !== CUE_BALL) continue
    firstContact = a === CUE_BALL ? b : a
    contactIndex = i
    break
  }

  const pocketed: number[] = []
  let eightBallPocket: number | null = null
  let railAfterContact = false
  const tocaramTabela = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.type === 'pocketed') {
      pocketed.push(e.ball as number)
      if (e.ball === 8) eightBallPocket = e.pocket as number
    } else if (e.type === 'ball-cushion') {
      tocaramTabela.add(e.ball as number)
      if (contactIndex >= 0 && i > contactIndex) railAfterContact = true
    }
  }
  tocaramTabela.delete(CUE_BALL)

  return {
    firstContact,
    pocketed,
    offTable: [],
    railAfterContact,
    ballsToRail: tocaramTabela.size,
    eightBallPocket,
    called: null,
    nominated: null,
  }
}
