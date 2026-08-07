import { createHash, randomBytes } from 'node:crypto'
import {
  applyShot,
  clampCue,
  DEFAULT_CUE,
  fixed as F,
  hashState,
  jitterFromSeed,
  rackBalls,
  table as T,
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
  type BallInHandRegion,
  type GameModeId,
  type MatchSummary,
  type PendingDecision,
} from '@zinc-pool/engine-rules'
import {
  MAX_PLACEMENTS,
  ShotRecorder,
  decodeAngle,
  decodePower,
  decodeSpin,
  type EncodedShot,
} from '@zinc-pool/replay'

/**
 * A partida, do lado do servidor.
 *
 * É AQUI que o resultado é decidido. O cliente simula em paralelo para poder
 * animar sem esperar a rede, mas o que vale é esta cópia: o cliente manda um
 * vetor de tacada e recebe de volta o que aconteceu.
 *
 * Duas escolhas de desenho sustentam o resto:
 *
 * **Sem I/O e sem timer real.** O tempo entra por `now` em cada chamada, e
 * nada aqui abre socket nem lê relógio. Prazo de tacada e W.O. são as regras
 * mais difíceis de acertar e as mais fáceis de testar errado; com o relógio
 * injetado, um teste avança duas horas numa linha.
 *
 * **A tacada trafega quantizada.** O cliente manda os mesmos u16/u8/i8 que vão
 * para o replay. Não existe conversão no meio do caminho onde os dois lados
 * possam discordar por um bit.
 */

export type MatchPlayer = {
  /** Carteira, que é a identidade em todo o sistema. */
  address: string
  cue: CueParams
}

export type MatchPhase =
  /** Esperando os dois revelarem o nonce que define a quebra. */
  | 'revealing'
  /** Alguém precisa escolher antes da próxima tacada. */
  | 'deciding'
  /** Vez de alguém jogar. */
  | 'playing'
  | 'finished'

export type MatchEndReason = 'regras' | 'desistência' | 'tempo' | 'replay cheio'

export type MatchError =
  | 'not_your_turn'
  | 'wrong_phase'
  | 'bad_shot'
  | 'bad_decision'
  | 'unknown_player'
  | 'already_revealed'
  | 'bad_reveal'

export class MatchRuleError extends Error {
  constructor(
    readonly code: MatchError,
    message: string,
  ) {
    super(message)
    this.name = 'MatchRuleError'
  }
}

/** Quanto tempo o jogador tem para tacar antes de perder a vez. */
export const SHOT_CLOCK_MS = 45_000

/**
 * Não existe W.O. por tempo. Estourar o prazo só passa a vez.
 *
 * A alternativa — declarar derrota depois de N faltas — parecia proteger quem
 * fica, mas punia quem teve uma queda de conexão de dois minutos. Passar a vez
 * resolve melhor e sem caso especial: quem está presente joga, quem sumiu
 * perde os turnos, e o jogo termina pelas REGRAS, com o vencedor tendo de fato
 * encaçapado as bolas.
 *
 * Quem voltar encontra a partida onde ela está e ainda pode jogar. E se
 * ninguém voltar, o prazo on-chain devolve o dinheiro aos dois — nunca fica
 * preso.
 */

/** Tempo para os dois revelarem o nonce antes de a partida ser anulada. */
export const REVEAL_TIMEOUT_MS = 60_000

/**
 * Com os DOIS desconectados, o relógio para.
 *
 * Sem isto, uma mesa abandonada pelos dois iria acumulando faltas sozinha e
 * chegaria a um "vencedor" que nem estava lá. Congelada, ela simplesmente
 * espera: o primeiro que voltar retoma de onde parou, e se ninguém voltar o
 * prazo on-chain devolve as entradas.
 */

export type ShotResultView = {
  /** Tacada como foi aplicada — o cliente reproduz exatamente isto. */
  shot: EncodedShot
  /** Quem tacou. */
  by: 0 | 1
  /** Hash do estado da mesa depois da tacada, para o cliente conferir. */
  stateHash: string
  ruling: unknown
  summary: MatchSummary
}

export type MatchEnded = {
  winner: 0 | 1 | null
  reason: MatchEndReason
  /** Bytes do replay, prontos para a liquidação on-chain. */
  replay: Uint8Array
}

/**
 * Semente da quebra por commit-reveal.
 *
 * Cada jogador escolhe um nonce em segredo e publica só o hash. Depois que os
 * dois se comprometeram, ambos revelam, e o seed é o hash da concatenação.
 *
 * Sem isso, quem definisse o seed escolheria a quebra — e com a física sendo
 * determinística, escolher a quebra é escolher onde as bolas param. Bastaria
 * procurar offline um seed favorável.
 */
export function seedFromNonces(a: Uint8Array, b: Uint8Array): Uint8Array {
  const h = createHash('sha256')
  h.update(a)
  h.update(b)
  return Uint8Array.from(h.digest())
}

export const commitOf = (nonce: Uint8Array): string =>
  createHash('sha256').update(nonce).digest('hex')

export const newNonce = (): Uint8Array => Uint8Array.from(randomBytes(32))

export class Match {
  readonly mode: GameModeId
  readonly players: [MatchPlayer, MatchPlayer]

  phase: MatchPhase = 'revealing'
  endReason: MatchEndReason | null = null

  /** Estado físico. O cliente tem uma cópia e as duas andam juntas. */
  table: TableState | null = null
  rules: unknown = null
  recorder: ShotRecorder | null = null

  /** Momento em que o prazo da vez expira. Null enquanto não há vez. */
  deadline: number | null = null

  #commits: [string | null, string | null] = [null, null]
  #nonces: [Uint8Array | null, Uint8Array | null] = [null, null]
  #offlineSince: [number | null, number | null] = [null, null]
  #startedAt: number

  constructor(
    mode: GameModeId,
    players: [MatchPlayer, MatchPlayer],
    commits: [string, string],
    now: number,
  ) {
    this.mode = mode
    this.players = [
      { ...players[0], cue: clampCue(players[0].cue ?? DEFAULT_CUE) },
      { ...players[1], cue: clampCue(players[1].cue ?? DEFAULT_CUE) },
    ]
    this.#commits = [commits[0], commits[1]]
    this.#startedAt = now
    this.deadline = now + REVEAL_TIMEOUT_MS
  }

  get modeApi() {
    return getGameMode(this.mode)
  }

  get summary(): MatchSummary | null {
    return this.rules === null ? null : this.modeApi.summarize(this.rules as never)
  }

  get pending(): PendingDecision | null {
    return this.rules === null ? null : this.modeApi.pendingOf(this.rules as never)
  }

  /**
   * Região onde a branca pode ser colocada, ou null se não há o que colocar.
   *
   * As regras mantêm o direito marcado até a PRÓXIMA tacada ser julgada, então
   * consultá-las direto diria "bola na mão" mesmo depois de o jogador já ter
   * colocado. O sinalizador abaixo registra o consumo, e é zerado a cada
   * tacada — uma bola na mão, uma posição.
   */
  get ballInHand(): BallInHandRegion | null {
    if (this.rules === null || this.#placed) return null
    return this.modeApi.ballInHandOf(this.rules as never)
  }

  /** A bola na mão desta vez já foi usada? */
  #placed = false

  /** De quem é a vez, ou null se a partida não está em andamento. */
  get turn(): 0 | 1 | null {
    if (this.phase === 'deciding') return this.pending?.chooser ?? null
    if (this.phase !== 'playing') return null
    return this.summary?.turn ?? null
  }

  indexOf(address: string): 0 | 1 | null {
    if (this.players[0].address === address) return 0
    if (this.players[1].address === address) return 1
    return null
  }

  // ------------------------------------------------------------- revelação

  /**
   * Recebe o nonce de um jogador.
   *
   * Confere contra o commit: sem essa checagem, o segundo a revelar escolheria
   * o nonce depois de ver o do adversário e controlaria a quebra sozinho — que
   * é exatamente o que o commit-reveal existe para impedir.
   */
  reveal(address: string, nonce: Uint8Array, now: number): boolean {
    const quem = this.#requirePlayer(address)
    if (this.phase !== 'revealing') {
      throw new MatchRuleError('wrong_phase', 'A quebra já foi definida.')
    }
    if (this.#nonces[quem]) {
      throw new MatchRuleError('already_revealed', 'Este jogador já revelou.')
    }
    if (commitOf(nonce) !== this.#commits[quem]) {
      throw new MatchRuleError('bad_reveal', 'O nonce não corresponde ao compromisso enviado.')
    }

    this.#nonces[quem] = nonce

    const [a, b] = this.#nonces
    if (!a || !b) return false

    this.#begin(seedFromNonces(a, b), now)
    return true
  }

  #begin(seed: Uint8Array, now: number): void {
    this.table = rackBalls(jitterFromSeed(seed))
    this.rules = this.modeApi.create(0)
    this.recorder = new ShotRecorder(this.mode, seed, [this.players[0].cue, this.players[1].cue])
    this.#enterTurn(now)
  }

  /** Ajusta fase e prazo conforme o que a partida espera agora. */
  #enterTurn(now: number): void {
    if (this.summary?.finished) {
      this.phase = 'finished'
      this.endReason = 'regras'
      this.deadline = null
      return
    }

    this.phase = this.pending ? 'deciding' : 'playing'
    this.deadline = now + SHOT_CLOCK_MS
  }

  // ----------------------------------------------------------------- jogo

  /**
   * Aplica a tacada de um jogador.
   *
   * A entrada já vem quantizada, e é ela que a física recebe. Validar as
   * faixas aqui não é paranoia: um cliente adulterado poderia mandar um u16
   * fora da volta ou uma força acima do máximo, e a física obedeceria.
   */
  /** A tacada da vez exige declarar bola e caçapa? */
  get callRequired(): boolean {
    return this.rules !== null && this.modeApi.callRequiredOf(this.rules as never)
  }

  shoot(
    address: string,
    shot: EncodedShot,
    now: number,
    call?: { ball: number; pocket: number },
  ): ShotResultView {
    const quem = this.#requirePlayer(address)
    if (this.phase !== 'playing') {
      throw new MatchRuleError('wrong_phase', 'A partida não está esperando uma tacada.')
    }
    if (this.turn !== quem) {
      throw new MatchRuleError('not_your_turn', 'Não é a sua vez.')
    }
    if (this.ballInHand !== null) {
      // A física recusaria de qualquer forma — a branca está encaçapada — mas
      // com uma mensagem sobre estado interno. Esta diz o que fazer.
      throw new MatchRuleError('wrong_phase', 'Coloque a branca antes de jogar.')
    }
    if (this.replayFull) {
      throw new MatchRuleError('wrong_phase', 'A partida atingiu o limite gravável.')
    }
    validarTacada(shot)

    if (this.callRequired && !call) {
      throw new MatchRuleError('bad_shot', 'Declare a caçapa antes de jogar na bola 8.')
    }

    return this.#applyShot(quem, shot, now, call)
  }

  /** Caminho único de aplicar tacada, usado pelo jogador e pelo prazo. */
  #applyShot(
    quem: 0 | 1,
    shot: EncodedShot,
    now: number,
    call?: { ball: number; pocket: number },
  ): ShotResultView {
    const table = this.table!
    const recorder = this.recorder!

    // A tacada encerra a bola na mão desta vez; a próxima falta abre outra.
    this.#placed = false

    // A declaração é gravada ANTES da tacada, na ordem em que o verificador a
    // consome, e SEMPRE que a regra exige — inclusive na tacada nula que o
    // relógio dispara. O verificador consome uma declaração por tacada exigida;
    // pular a do relógio desalinharia as duas listas dali em diante.
    if (this.callRequired) {
      const declarada = call ?? CACAPA_PADRAO
      recorder.recordCall(declarada.ball, declarada.pocket)
    }
    recorder.record(shot)

    const resultado = applyShot(table, {
      intent: {
        angle: F.from(decodeAngle(shot.angle)),
        power: F.from(decodePower(shot.power)),
        spin: { x: F.from(decodeSpin(shot.spinX)), y: F.from(decodeSpin(shot.spinY)) },
      },
      cue: this.players[quem].cue,
      isBreak: recorder.shotCount === 1,
    })

    // As mesmas três chamadas do cliente e do verificador de replay.
    const outcome = fullOutcome(outcomeFromEvents(resultado.events), {
      called: call ?? null,
    })
    const { state, ruling } = this.modeApi.play(this.rules as never, outcome as never)
    this.rules = state
    settleTable(table, ruling, { ballInHand: this.ballInHand !== null })

    this.#enterTurn(now)

    return {
      shot,
      by: quem,
      stateHash: hashState(table),
      ruling,
      summary: this.modeApi.summarize(this.rules as never),
    }
  }

  /**
   * Põe a branca onde o jogador escolheu, numa bola na mão.
   *
   * A posição é quantizada pelo gravador e é a QUANTIZADA que a física recebe.
   * Sem esta etapa a partida seguiria de um ponto que ninguém escolheu — e o
   * verificador, que lê a posição do replay, chegaria a outra mesa.
   */
  place(address: string, x: number, y: number, now: number): { x: number; y: number } {
    const quem = this.#requirePlayer(address)
    if (this.phase !== 'playing' || this.ballInHand === null) {
      throw new MatchRuleError('wrong_phase', 'Não há bola na mão agora.')
    }
    if (this.summary?.turn !== quem) {
      throw new MatchRuleError('not_your_turn', 'A bola na mão não é sua.')
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new MatchRuleError('bad_shot', 'Posição inválida.')
    }

    const onde = this.recorder!.placeCueBall(x, y)
    placeCueBall(this.table!, F.from(onde.x), F.from(onde.y))
    this.#placed = true

    // Colocar a bola é ação voluntária: reinicia o relógio como uma tacada.
    this.deadline = now + SHOT_CLOCK_MS
    return onde
  }

  /**
   * Registra a escolha do jogador numa decisão aberta pelas regras.
   *
   * Devolve se o triângulo foi rearmado. Quem avisa é o núcleo, porque só ele
   * sabe — deduzir isso de fora, contando bolas na mesa, daria certo hoje e
   * erraria na primeira modalidade que rearmasse por outro motivo.
   */
  decide(address: string, optionIndex: number, now: number): { rerack: boolean } {
    const quem = this.#requirePlayer(address)
    if (this.phase !== 'deciding') {
      throw new MatchRuleError('wrong_phase', 'Não há decisão pendente.')
    }
    const pendencia = this.pending!
    if (pendencia.chooser !== quem) {
      throw new MatchRuleError('not_your_turn', 'A escolha não é sua.')
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= pendencia.options.length) {
      throw new MatchRuleError('bad_decision', `Opção ${optionIndex} não existe.`)
    }

    this.recorder!.recordDecision(optionIndex)

    const { state, rerack } = this.modeApi.resolve(this.rules as never, optionIndex)
    this.rules = state
    if (rerack) rerackTable(this.table!, this.recorder!.seed)

    this.#enterTurn(now)

    return { rerack }
  }

  // -------------------------------------------------------------- término

  /** Desistência explícita. */
  forfeit(address: string, now: number): void {
    const quem = this.#requirePlayer(address)
    if (this.phase === 'finished') return

    this.#finish(outro(quem), 'desistência')
  }

  /** O jogador caiu. Começa a contar a tolerância. */
  markOffline(address: string, now: number): void {
    const quem = this.indexOf(address)
    if (quem === null) return
    this.#offlineSince[quem] ??= now
  }

  markOnline(address: string): void {
    const quem = this.indexOf(address)
    if (quem === null) return
    this.#offlineSince[quem] = null
  }

  /**
   * Avança o relógio. Chame periodicamente; devolve o que mudou.
   *
   * Concentrar as três regras de tempo aqui — revelação, prazo de tacada e
   * desconexão — é o que evita que cada uma vire um `setTimeout` solto com o
   * seu próprio jeito de errar.
   */
  /**
   * Cabe mais alguma coisa no replay?
   *
   * Contra um adversário ausente, cada rodada gasta duas tacadas — a nula do
   * relógio e a de quem está jogando — mais uma posição de bola na mão. O
   * espaço acaba antes de a partida acabar.
   */
  get replayFull(): boolean {
    const r = this.recorder
    if (!r) return false
    return r.remaining < 2 || r.placementCount >= MAX_PLACEMENTS - 1
  }

  tick(now: number): { changed: boolean; timedOut: 0 | 1 | null } {
    if (this.phase === 'finished') return { changed: false, timedOut: null }

    // Sem espaço para gravar, não há como PROVAR o resultado. Declarar um
    // vencedor que o replay não sustenta quebraria a única coisa que o sistema
    // promete de verdade, então a partida é anulada e as entradas voltam.
    if (this.replayFull) {
      this.#finish(null, 'replay cheio')
      return { changed: true, timedOut: null }
    }

    // Ninguém olhando: o relógio para. Deixar correr faria a mesa acumular
    // faltas sozinha e chegar a um "vencedor" que nem estava lá.
    if (this.#offlineSince[0] !== null && this.#offlineSince[1] !== null) {
      return { changed: false, timedOut: null }
    }

    if (this.deadline === null || now < this.deadline) {
      return { changed: false, timedOut: null }
    }

    if (this.phase === 'revealing') {
      // Ninguém pode ser declarado vencedor: a partida nem começou. O escrow
      // volta pelos dois pelo caminho de cancelamento on-chain.
      this.#finish(null, 'tempo')
      return { changed: true, timedOut: null }
    }

    const quem = this.turn
    if (quem === null) return { changed: false, timedOut: null }

    // Só passa a vez. Quem sumiu vai perdendo turnos; quem ficou joga e vence
    // pelas regras, tendo de fato encaçapado as bolas.
    this.#onDeadlineMissed(quem, now)
    return { changed: true, timedOut: quem }
  }

  /**
   * Consequência de estourar o prazo.
   *
   * Não existe "passar a vez" fora das regras. Pela WPA, deixar o relógio
   * correr é uma FALTA comum, e as regras já sabem julgá-la — inventar uma
   * transição paralela criaria um segundo jeito de a partida avançar, que o
   * verificador de replay não conheceria.
   *
   * A falta é registrada como uma TACADA DE FORÇA ZERO. A branca não sai do
   * lugar, nenhuma bola é tocada, e as regras julgam exatamente o que
   * aconteceu: falta por não tocar em bola. Custa 5 bytes no replay e é
   * reproduzida sem nenhum caso especial.
   *
   * Decisão pendente é outra história: ela pertence a quem a regra deu, e
   * transferi-la mudaria o jogo. Escolhe-se a primeira opção, que nas duas
   * situações da WPA é a conservadora — aceitar a mesa como está.
   */
  #onDeadlineMissed(quem: 0 | 1, now: number): void {
    if (this.phase === 'deciding') {
      this.decide(this.players[quem].address, 0, now)
      return
    }

    // Bola na mão pendente: quem não coloca a tempo fica com o ponto de saque,
    // que é a posição neutra. Precisa acontecer antes da tacada nula, senão a
    // física receberia a branca ainda encaçapada.
    if (this.ballInHand !== null) {
      const onde = this.recorder!.placeCueBall(
        F.toNumber(T.CUE_SPOT.x),
        F.toNumber(T.CUE_SPOT.y),
      )
      placeCueBall(this.table!, F.from(onde.x), F.from(onde.y))
      this.#placed = true
    }

    this.#applyShot(quem, TACADA_NULA, now)
  }

  #finish(winner: 0 | 1 | null, reason: MatchEndReason): void {
    this.phase = 'finished'
    this.endReason = reason
    this.deadline = null
    this.#winnerOverride = winner
  }

  #winnerOverride: 0 | 1 | null = null

  /** Resultado final, ou null se a partida não acabou. */
  result(): MatchEnded | null {
    if (this.phase !== 'finished') return null

    const porRegras = this.summary?.winner ?? null

    return {
      // Fim por regras usa o vencedor das regras; os outros usam quem sobrou.
      winner: this.endReason === 'regras' ? porRegras : this.#winnerOverride,
      reason: this.endReason ?? 'regras',
      replay: this.recorder?.toBytes() ?? new Uint8Array(0),
    }
  }

  /** Há quanto tempo a partida existe, para métricas e para o painel. */
  ageMs(now: number): number {
    return now - this.#startedAt
  }

  #requirePlayer(address: string): 0 | 1 {
    const quem = this.indexOf(address)
    if (quem === null) {
      throw new MatchRuleError('unknown_player', 'Esta carteira não está nesta partida.')
    }
    return quem
  }
}

const outro = (quem: 0 | 1): 0 | 1 => (quem === 0 ? 1 : 0)

/**
 * A tacada que o relógio dá por você.
 *
 * Força zero: a branca não sai do lugar, nenhuma bola é tocada, e as regras
 * julgam falta por falta de contato — que é o que a WPA prescreve para
 * violação de tempo. Reproduz no replay sem nenhum caso especial.
 */
const TACADA_NULA: EncodedShot = { angle: 0, power: 0, spinX: 0, spinY: 0 }

/**
 * Declaração usada quando o relógio joga pelo jogador.
 *
 * Nada é encaçapado numa tacada de força zero, então a declaração não muda o
 * julgamento — a falta será por falta de contato. Ela existe só para as listas
 * do jogo e do verificador continuarem alinhadas.
 */
const CACAPA_PADRAO = { ball: 8, pocket: 0 }

/**
 * Valida as faixas da tacada.
 *
 * O cliente é hostil por definição: qualquer coisa que chegue pela rede pode
 * ter sido escrita à mão. Um `angle` acima de 65535 ou um `power` de 9000
 * passariam direto para a física.
 */
function validarTacada(shot: EncodedShot): void {
  const inteiro = (v: unknown): v is number => Number.isInteger(v)

  if (!inteiro(shot.angle) || shot.angle < 0 || shot.angle > 65_535) {
    throw new MatchRuleError('bad_shot', `Ângulo fora da faixa: ${shot.angle}.`)
  }
  if (!inteiro(shot.power) || shot.power < 0 || shot.power > 255) {
    throw new MatchRuleError('bad_shot', `Força fora da faixa: ${shot.power}.`)
  }
  for (const eixo of ['spinX', 'spinY'] as const) {
    const v = shot[eixo]
    if (!inteiro(v) || v < -127 || v > 127) {
      throw new MatchRuleError('bad_shot', `Efeito fora da faixa em ${eixo}: ${v}.`)
    }
  }
}
