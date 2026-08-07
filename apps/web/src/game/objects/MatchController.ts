import { Entity } from '@/game/core/entity'
import {
  CUE_BALL,
  DEFAULT_CUE,
  applyShot,
  beginShot,
  clampCue,
  cloneState,
  fixed as F,
  hashState,
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
  placeCueBall,
  rerackTable,
  settleTable,
  type GameModeId,
  type MatchSummary,
  type PendingDecision,
} from '@zinc-pool/engine-rules'
import {
  ShotRecorder,
  decodeAngle,
  decodePower,
  decodeSpin,
  type EncodedShot,
} from '@zinc-pool/replay'

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

/**
 * Marcador de "aplique sem conferir o hash".
 *
 * Usado só na reconstrução do histórico, em que o servidor manda tudo de uma
 * vez e não há um hash por tacada. É uma string impossível de o motor produzir
 * — o hash real tem 8 dígitos hexadecimais.
 */
const SEM_CONFERIR = '(reconstrução)'

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

  /**
   * Ligação com o servidor. Ausente em hotseat.
   *
   * Quando presente, a mesa vira uma PREVISÃO: a tacada é aplicada aqui na
   * hora, para o jogador não esperar a rede, e mandada ao servidor. Como a
   * física é determinística e o servidor recebe os mesmos inteiros, a previsão
   * é exata — não existe rollback a fazer, só a conferência do hash.
   */
  net: {
    you: 0 | 1
    submit(shot: EncodedShot): void
    submitPlacement(p: { x: number; y: number }): void
  } | null = null

  /** Divergência detectada entre a nossa mesa e a do servidor. */
  desync: string | null = null

  /**
   * Região onde a branca pode ser colocada, ou null.
   *
   * Enquanto houver bola na mão, a branca fica marcada como encaçapada e não
   * há tacada possível: o jogador precisa escolher a posição primeiro, e essa
   * escolha vai gravada no replay.
   */
  get ballInHand() {
    // As regras mantêm o direito marcado até a próxima tacada ser julgada; o
    // sinalizador registra que a posição desta vez já foi escolhida.
    if (this.#placed) return null
    return this.mode.ballInHandOf(this.rules as never)
  }

  /** A bola na mão desta vez já foi usada? */
  #placed = false

  get canShoot(): boolean {
    if (this.phase !== 'aiming' || this.pending !== null) return false
    if (this.ballInHand !== null) return false
    // Em rede, só na própria vez. O servidor recusaria de qualquer forma; a
    // guarda aqui é para a mira nem aparecer fora do turno.
    if (this.net && this.summary.turn !== this.net.you) return false
    return true
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

    this.#placed = false
    const tacada = this.recorder.take(angle, Math.max(0, Math.min(1, power)), spin)

    // Manda antes de simular: a rede leva mais tempo que a simulação, e o
    // servidor precisa dos mesmos inteiros que acabamos de gravar.
    this.net?.submit(tacada.encoded)

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

  /**
   * Tacada vinda do servidor.
   *
   * Para a tacada do adversário, aplica. Para a nossa, que já foi aplicada por
   * previsão, apenas confere o hash — se divergir, a nossa mesa deixou de
   * representar a partida e insistir só pioraria.
   */
  applyRemoteShot(by: 0 | 1, shot: EncodedShot, stateHash: string): void {
    // Na reconstrução não há hash por tacada para conferir: o servidor manda o
    // histórico inteiro de uma vez. A conferência volta na próxima tacada ao
    // vivo, que é quando ela pode de fato acusar divergência.
    if (stateHash === SEM_CONFERIR) {
      this.#aplicarTacada(by, shot)
      return
    }

    if (this.net && by === this.net.you) {
      const nosso = hashState(this.table)
      if (nosso !== stateHash && this.phase !== 'simulating') {
        this.desync = `mesa divergiu do servidor (${nosso} ≠ ${stateHash})`
      }
      return
    }

    this.#aplicarTacada(by, shot)

    const nosso = hashState(this.table)
    if (nosso !== stateHash) {
      this.desync = `mesa divergiu do servidor (${nosso} ≠ ${stateHash})`
    }
  }

  /** Aplica uma tacada de fora e julga, sem animar. */
  #aplicarTacada(by: 0 | 1, shot: EncodedShot): void {
    // A tacada encerra a bola na mão desta vez; a próxima falta abre outra.
    this.#placed = false
    this.recorder.record(shot)

    // Roda de uma vez, sem animar: a tacada já aconteceu do outro lado, e
    // reproduzi-la quadro a quadro só atrasaria a nossa mesa em relação à
    // partida real.
    const resultado = applyShot(this.table, {
      intent: {
        angle: F.from(decodeAngle(shot.angle)),
        power: F.from(decodePower(shot.power)),
        spin: { x: F.from(decodeSpin(shot.spinX)), y: F.from(decodeSpin(shot.spinY)) },
      },
      cue: this.cues[by],
      isBreak: this.recorder.shotCount === 1,
    })

    this.#events = [...resultado.events]
    this.#resolveShot()
  }

  /**
   * Reconstrói a partida a partir do histórico.
   *
   * Para quem chega no meio: a mesa é armada pelo seed e depois avança tacada
   * a tacada até o estado atual. Não é animado — o jogador precisa ver onde a
   * partida ESTÁ, não assistir de novo ao que perdeu.
   *
   * A ordem entre tacada e decisão segue a mesma regra do verificador de
   * replay: se as regras abriram uma escolha, ela vem antes da próxima tacada.
   * As regras recusam jogar com pendência aberta, então essa ordem não é
   * escolha nossa. Há teste comparando uma mesa reconstruída com uma que jogou
   * ao vivo — se as duas divergirem, é aqui que se descobre.
   */
  catchUp(
    shots: readonly EncodedShot[],
    decisions: readonly number[],
    placements: readonly { x: number; y: number }[] = [],
  ): void {
    const pendentes = [...decisions]
    const posicoes = [...placements]

    for (const shot of shots) {
      if (this.summary.finished) break

      if (this.pending) {
        const escolha = pendentes.shift()
        if (escolha === undefined) break
        this.choose(escolha)
      }

      // Mesma ordem do verificador: decisão, depois bola na mão, depois a
      // tacada. Sem a posição, a branca continuaria encaçapada e a física
      // recusaria a tacada seguinte.
      if (this.ballInHand) {
        const onde = posicoes.shift()
        if (!onde) break
        this.applyRemotePlacement(onde.x, onde.y)
      }

      const turno = this.summary.turn
      this.applyRemoteShot(turno, shot, SEM_CONFERIR)
    }

    // Decisão aberta no fim da partida ainda não foi respondida por ninguém;
    // ela chega pelo `match.decision` normal.
    this.#capturePrevious()
  }

  /**
   * Recoloca a branca numa bola na mão.
   *
   * A posição é QUANTIZADA pelo gravador antes de ir para a física, mesma
   * regra da tacada: colocar num ponto e gravar outro faria o replay
   * reproduzir uma partida diferente dali em diante.
   */
  placeCueBall(x: number, y: number): void {
    if (this.ballInHand === null) return

    const onde = this.recorder.placeCueBall(x, y)
    this.net?.submitPlacement(onde)
    placeCueBall(this.table, F.from(onde.x), F.from(onde.y))
    this.#placed = true
    this.#capturePrevious()
  }

  /** Posição vinda do servidor, na bola na mão do adversário. */
  applyRemotePlacement(x: number, y: number): void {
    if (this.ballInHand === null) return
    this.recorder.placeCueBall(x, y)
    placeCueBall(this.table, F.from(x), F.from(y))
    this.#placed = true
    this.#capturePrevious()
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

    settleTable(this.table, ruling, { ballInHand: this.ballInHand !== null })

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
