import { Entity, type FrameContext } from '@/game/core/entity'
import { outcomeFromEvents } from '@/game/outcome'
import {
  CUE_BALL,
  beginShot,
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
  type TableState,
} from '@zinc-pool/engine-physics'
import { getGameMode, type GameModeId, type MatchSummary } from '@zinc-pool/engine-rules'

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

  constructor(
    readonly modeId: GameModeId,
    seed = 1,
  ) {
    super('MatchController')
    this.table = rackBalls(jitterFromSeed(new Uint8Array(32).fill(seed)))
    this.rules = this.mode.create(0)
    this.#capturePrevious()
  }

  get mode() {
    return getGameMode(this.modeId)
  }

  get summary(): MatchSummary {
    return this.mode.summarize(this.rules as never)
  }

  get canShoot(): boolean {
    return this.phase === 'aiming'
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

  /** Dispara a tacada. A simulação corre nos próximos quadros. */
  shoot(angle: number, power: number, spin?: { x: number; y: number }): void {
    if (!this.canShoot) return

    beginShot(this.table, {
      intent: {
        angle: F.from(angle),
        power: F.from(Math.max(0, Math.min(1, power))),
        ...(spin ? { spin: { x: F.from(spin.x), y: F.from(spin.y) } } : {}),
      },
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
    const fisico = outcomeFromEvents(this.#events)

    // Cada modalidade lê campos diferentes; mandar todos é mais simples e mais
    // barato que ramificar aqui — e mantém este arquivo sem saber qual jogo é.
    const outcome = {
      ...fisico,
      called: null,
      nominated: null,
    }

    const { state, ruling } = this.mode.play(this.rules as never, outcome as never)

    this.rules = state
    this.lastRuling = ruling
    this.lastMessage = descreverJulgamento(ruling as Record<string, unknown>)

    // A branca encaçapada volta para a mesa antes da próxima tacada.
    const branca = this.cueBall
    if (branca?.pocketed) {
      branca.pocketed = false
      V.copy(branca.position, T.CUE_SPOT)
      V.set(branca.velocity, 0, 0)
      V.set(branca.spin, 0, 0)
    }

    // Bolas que as regras mandaram devolver voltam ao ponto de pé.
    const respot = (ruling as { respot?: number[] }).respot ?? []
    for (const id of respot) {
      const bola = this.table.balls.find((b) => b.id === id)
      if (bola?.pocketed) {
        bola.pocketed = false
        V.copy(bola.position, T.FOOT_SPOT)
        V.set(bola.velocity, 0, 0)
      }
    }

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
