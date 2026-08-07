import { Entity } from '@/game/core/entity'
import {
  CUE_BALL,
  DEFAULT_CUE,
  beginShot,
  clampCue,
  cloneState,
  fixed as F,
  isMoving,
  jitterFromSeed,
  rackBalls,
  step,
  table as T,
  vec as V,
  type Ball,
  type CollisionEvent,
  type CueParams,
  type TableState,
} from '@zinc-pool/engine-physics'
import {
  fullOutcome,
  getGameMode,
  outcomeFromEvents,
  rerackTable,
  settleTable,
  type GameModeId,
  type MatchSummary,
  type PendingDecision,
} from '@zinc-pool/engine-rules'
import { ShotRecorder } from '@zinc-pool/replay'

/**
 * Dono do estado da partida.
 *
 * O equivalente ao "GameManager" de uma cena da Unity: junta física e regras e
 * expõe uma visão simples para os objetos de desenho. Nenhum objeto visual
 * conhece `TableState` nem o motor de regras — eles perguntam a este.
 *
 * A física roda no `fixedUpdate`, em passos constantes, e é a MESMA função que
 * o servidor usa. Isso é o que permite ao cliente prever a tacada e chegar ao
 * resultado idêntico ao dele.
 */
export type MatchPhase = 'aiming' | 'simulating' | 'finished'

export class MatchController extends Entity {
  /** Estado físico da mesa. */
  table: TableState

  /** Estado de regras, opaco — só o modo sabe interpretar. */
  rules: unknown

  phase: MatchPhase = 'aiming'

  /** Último julgamento, para a interface explicar o que houve. */
  lastRuling: unknown = null

  /** Mensagem curta do que acabou de acontecer. */
  lastMessage: string | null = null

  /** Estado antes do passo atual, para interpolar o desenho. */
  #previous: Map<number, { x: number; y: number }> = new Map()

  #events: CollisionEvent[] = []
  #steps = 0

  /** Grava a partida no formato que vai para a blockchain. */
  readonly recorder: ShotRecorder

  /** Taco de cada jogador. Vem do NFT quando houver; hoje, o padrão. */
  readonly cues: [CueParams, CueParams]

  constructor(
    readonly modeId: GameModeId,
    seed: number | Uint8Array = 1,
    cues?: [CueParams, CueParams],
  ) {
    super('MatchController')

    // O seed dos 32 bytes é o mesmo que alimenta o jitter e que vai gravado no
    // replay. Guardar um número e derivar os bytes em dois lugares seria pedir
    // para eles divergirem.
    const bytes = typeof seed === 'number' ? new Uint8Array(32).fill(seed) : seed.slice()

    this.cues = [clampCue(cues?.[0] ?? DEFAULT_CUE), clampCue(cues?.[1] ?? DEFAULT_CUE)]
    this.recorder = new ShotRecorder(modeId, bytes, this.cues)

    this.table = rackBalls(jitterFromSeed(bytes))
    this.rules = this.mode.create(0)
    this.#capturePrevious()
  }

  get mode() {
    return getGameMode(this.modeId)
  }

  get summary(): MatchSummary {
    return this.mode.summarize(this.rules as never)
  }

  /**
   * Escolha aberta esperando o jogador, se houver.
   *
   * A interface precisa consultar isto: enquanto houver pendência, as regras
   * recusam a próxima tacada. É o caso da quebra irregular no 8-Ball, em que a
   * WPA dá ao adversário o direito de aceitar a mesa ou mandar quebrar de novo.
   */
  get pending(): PendingDecision | null {
    return this.mode.pendingOf(this.rules as never)
  }

  get canShoot(): boolean {
    return this.phase === 'aiming' && this.pending === null
  }

  /**
   * Aplica a escolha do jogador e libera a próxima tacada.
   *
   * Grava no replay antes de aplicar, pela mesma razão da tacada: o verificador
   * precisa refazer exatamente esta escolha, e uma decisão não gravada faria a
   * partida ser reproduzida por outro caminho.
   */
  choose(optionIndex: number): void {
    const pendencia = this.pending
    if (!pendencia) return

    this.recorder.recordDecision(optionIndex)

    const { state, rerack } = this.mode.resolve(this.rules as never, optionIndex)
    this.rules = state

    // Rearmar o triângulo é obrigação de quem controla a mesa: as regras zeram
    // as bolas encaçapadas, mas não movem bola nenhuma.
    if (rerack) rerackTable(this.table, this.recorder.seed)

    this.lastMessage = pendencia.options[optionIndex] ?? null
    this.phase = this.summary.finished ? 'finished' : 'aiming'
    this.#capturePrevious()
  }

  get cueBall(): Ball | undefined {
    return this.table.balls.find((b) => b.id === CUE_BALL)
  }

  /**
   * Posição interpolada da bola, para desenhar sem tremor.
   *
   * A física anda em degraus de 1/240s; o monitor desenha quando quer. Sem
   * interpolar, o movimento fica trepidante mesmo com a simulação correta.
   */
  interpolated(ball: Ball, alpha: number): { x: number; y: number } {
    const anterior = this.#previous.get(ball.id)
    const atual = { x: F.toNumber(ball.position.x), y: F.toNumber(ball.position.y) }
    if (!anterior) return atual

    return {
      x: anterior.x + (atual.x - anterior.x) * alpha,
      y: anterior.y + (atual.y - anterior.y) * alpha,
    }
  }

  /**
   * Dispara a tacada. A simulação corre nos próximos quadros.
   *
   * A entrada é quantizada ANTES de simular, e é o valor quantizado que a
   * física recebe. Se simulássemos o ângulo cru do mouse e só arredondássemos
   * na gravação, o replay reproduziria outra partida — e o vencedor gravado na
   * blockchain não bateria com o verificado.
   */
  shoot(angle: number, power: number, spin?: { x: number; y: number }): void {
    if (!this.canShoot) return
    if (this.recorder.remaining <= 0) {
      this.lastMessage = 'Limite de tacadas do replay atingido.'
      return
    }

    const tacada = this.recorder.take(angle, Math.max(0, Math.min(1, power)), spin)

    beginShot(this.table, {
      intent: {
        angle: F.from(tacada.angle),
        power: F.from(tacada.power),
        spin: { x: F.from(tacada.spin.x), y: F.from(tacada.spin.y) },
      },
      cue: this.cues[this.summary.turn],
      isBreak: !this.#jaQuebrou,
    })

    this.#events = []
    this.#steps = 0
    this.phase = 'simulating'
    this.lastMessage = null
  }

  /** Recoloca a branca (bola na mão). */
  placeCueBall(x: number, y: number): void {
    const branca = this.cueBall
    if (!branca) return

    const raio = F.toNumber(T.BALL_RADIUS)
    const px = Math.max(raio, Math.min(F.toNumber(T.WIDTH) - raio, x))
    const py = Math.max(raio, Math.min(F.toNumber(T.HEIGHT) - raio, y))

    V.set(branca.position, F.from(px), F.from(py))
    V.set(branca.velocity, 0, 0)
    V.set(branca.spin, 0, 0)
    branca.pocketed = false
  }

  override fixedUpdate(): void {
    if (this.phase !== 'simulating') return

    this.#capturePrevious()
    this.#events.push(...step(this.table))
    this.#steps++

    const parou = !isMoving(this.table)
    const estourou = this.#steps >= T.MAX_STEPS

    if (parou || estourou) this.#resolveShot()
  }

  // ------------------------------------------------------------- interno

  get #jaQuebrou(): boolean {
    const resumo = this.summary
    // Mesa cheia significa que a quebra ainda não aconteceu.
    return resumo.onTable.length < this.mode.info.ballCount
  }

  #capturePrevious(): void {
    for (const bola of this.table.balls) {
      this.#previous.set(bola.id, {
        x: F.toNumber(bola.position.x),
        y: F.toNumber(bola.position.y),
      })
    }
  }

  /** Traduz os eventos, julga pelas regras e prepara a próxima tacada. */
  #resolveShot(): void {
    // Estas três chamadas são compartilhadas com o verificador de replay
    // (engine-rules/bridge.ts). Não reimplemente nenhuma delas aqui: é
    // exatamente a divergência entre as duas cópias que quebra a auditoria.
    const outcome = fullOutcome(outcomeFromEvents(this.#events))
    const { state, ruling } = this.mode.play(this.rules as never, outcome as never)

    this.rules = state
    this.lastRuling = ruling
    this.lastMessage = descreverJulgamento(ruling as Record<string, unknown>)

    settleTable(this.table, ruling)

    this.phase = this.summary.finished ? 'finished' : 'aiming'
    this.#capturePrevious()
  }

  /** Cópia do estado físico, para quem precisar do anterior. */
  snapshot(): TableState {
    return cloneState(this.table)
  }
}

/** Texto curto do que aconteceu, comum às duas modalidades. */
function descreverJulgamento(ruling: Record<string, unknown>): string | null {
  const foul = ruling.foul as string | null
  if (foul) return FALTAS[foul] ?? 'Falta.'

  const scored = ruling.scored as number | undefined
  if (typeof scored === 'number' && scored > 0) return `+${scored} pontos`

  if (ruling.continues === true) return 'Encaçapou — segue na mesa.'
  return null
}

const FALTAS: Record<string, string> = {
  'cue-ball-pocketed': 'Branca na caçapa.',
  'cue-ball-off-table': 'Branca fora da mesa.',
  'ball-off-table': 'Bola fora da mesa.',
  'no-contact': 'Não tocou em nenhuma bola.',
  'wrong-ball-first': 'Bateu na bola errada.',
  'eight-ball-first-illegal': 'Não pode bater na 8 ainda.',
  'no-rail-after-contact': 'Nenhuma bola foi à tabela.',
  'no-call': 'Faltou declarar a caçapa.',
  'wrong-ball-called': 'Encaçapou outra bola.',
  'free-ball-missed': 'Errou a bola livre.',
}
