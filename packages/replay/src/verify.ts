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
} from '@zinc-pool/engine-physics'
import {
  fullOutcome,
  getGameMode,
  outcomeFromEvents,
  rerackTable,
  settleTable,
} from '@zinc-pool/engine-rules'
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

  const decisoes = [...(replay.decisions ?? [])]

  for (const shot of replay.shots) {
    const resumo = mode.summarize(rules as never)
    if (resumo.finished) {
      parou = 'a partida já havia terminado'
      break
    }

    // Decisões abertas pela tacada anterior são resolvidas ANTES da próxima.
    // As regras recusam jogar com pendência, então esta ordem não é escolha.
    const pendencia = mode.pendingOf(rules as never)
    if (pendencia) {
      const escolha = decisoes.shift()
      if (escolha === undefined) {
        parou = `faltou no replay a escolha de "${pendencia.kind}"`
        break
      }
      const resolvida = mode.resolve(rules as never, escolha)
      rules = resolvida.state
      if (resolvida.rerack) rerackTable(table, replay.seed)
    }

    // O taco é o do jogador da VEZ — cada um joga com o seu. Relido depois da
    // decisão, que pode ter passado a vez para o outro.
    const cue = clampCue(replay.cues[mode.summarize(rules as never).turn])

    const resultado = applyShot(table, {
      intent: {
        angle: F.from(decodeAngle(shot.angle)),
        power: F.from(decodePower(shot.power)),
        spin: { x: F.from(decodeSpin(shot.spinX)), y: F.from(decodeSpin(shot.spinY)) },
      },
      cue,
      isBreak: aplicadas === 0,
    })

    // Exatamente as mesmas três chamadas que o jogo faz, na mesma ordem. Ver
    // o aviso em engine-rules/bridge.ts: se divergirem, o replay não prova nada.
    const outcome = fullOutcome(outcomeFromEvents(resultado.events))
    const { state, ruling } = mode.play(rules as never, outcome as never)
    rules = state
    settleTable(table, ruling)

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

