import { Match, MatchRuleError, type MatchEnded } from '@/match'
import { DEFAULT_CUE } from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'

/**
 * Registro de partidas em andamento.
 *
 * A `Match` é lógica pura e não sabe que horas são; este módulo é o único
 * lugar que lê o relógio de verdade e chama `tick`. Manter essa fronteira é o
 * que permite testar todas as regras de tempo sem esperar um segundo sequer.
 *
 * Um `tick` só, para todas as partidas, em vez de um `setTimeout` por prazo:
 * com um timer por jogador por turno, cancelar e reagendar vira o caminho mais
 * curto para um W.O. disparado numa partida que já acabou.
 */

export type MatchEvent =
  | { t: 'begin'; matchId: string; mode: GameModeId; players: [string, string] }
  | { t: 'revealOpen'; matchId: string }
  | { t: 'start'; matchId: string; seed: Uint8Array }
  | { t: 'shot'; matchId: string; view: ReturnType<Match['shoot']>; byClock?: boolean }
  | { t: 'decision'; matchId: string }
  | { t: 'ballInHand'; matchId: string }
  | { t: 'callRequired'; matchId: string }
  | { t: 'placed'; matchId: string; by: 0 | 1; x: number; y: number; byClock?: boolean }
  | { t: 'decided'; matchId: string; chooser: 0 | 1; option: number; rerack: boolean }
  | { t: 'offline'; matchId: string; who: 0 | 1 }
  | { t: 'online'; matchId: string; who: 0 | 1 }
  /**
   * A partida acabou.
   *
   * Carrega os jogadores porque, quando este evento sai, a partida já foi
   * removida do registro — quem escuta não teria mais como descobrir para
   * quem mandar o resultado.
   */
  | { t: 'end'; matchId: string; players: [string, string]; result: MatchEnded }

/** De quanto em quanto tempo os prazos são conferidos. */
export const TICK_MS = 1_000

export class Matches {
  #byId = new Map<string, Match>()
  /** address → matchId. Um jogador, uma partida. */
  #byPlayer = new Map<string, string>()
  #listeners = new Set<(e: MatchEvent) => void>()
  #timer: ReturnType<typeof setInterval> | null = null
  #commits = new Map<string, [string | null, string | null]>()
  #pendentes = new Map<string, { mode: GameModeId; players: [string, string] }>()

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: (e: MatchEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(e: MatchEvent): void {
    for (const l of this.#listeners) l(e)
  }

  get(matchId: string): Match | undefined {
    return this.#byId.get(matchId)
  }

  /**
   * Esta partida já existe, mesmo que ainda esperando os compromissos?
   *
   * Diferente de `get`, que só enxerga partida já nascida. Quem só perguntasse
   * por `get` reabriria uma partida pendente — e reabrir APAGA os compromissos
   * já enviados, deixando os dois jogadores presos até o prazo da revelação.
   */
  has(matchId: string): boolean {
    return this.#byId.has(matchId) || this.#pendentes.has(matchId)
  }

  matchOf(address: string): { matchId: string; match: Match } | null {
    const id = this.#byPlayer.get(address)
    if (!id) return null
    const match = this.#byId.get(id)
    return match ? { matchId: id, match } : null
  }

  get active(): number {
    return this.#byId.size
  }

  /**
   * Estado atual de um jogador, para ele reencontrar a partida ao reconectar.
   *
   * Indispensável, não conveniência: ir do lobby para a mesa abre um socket
   * NOVO, e as mensagens que já passaram não voltam sozinhas. Sem isto o
   * jogador chegaria na mesa e ficaria esperando um `match.begin` que nunca
   * viria.
   *
   * Cobre os dois momentos: a partida ainda esperando os compromissos, e a
   * partida já em andamento.
   */
  resume(address: string): {
    matchId: string
    mode: GameModeId
    players: [string, string]
    you: 0 | 1
    /** Presente só se a partida já nasceu. */
    match: Match | null
    /** Este jogador já mandou o compromisso? */
    committed: boolean
  } | null {
    const matchId = this.#byPlayer.get(address)
    if (!matchId) return null

    const vivo = this.#byId.get(matchId)
    if (vivo) {
      const you = vivo.indexOf(address)
      if (you === null) return null
      return {
        matchId,
        mode: vivo.mode,
        players: [vivo.players[0].address, vivo.players[1].address],
        you,
        match: vivo,
        committed: true,
      }
    }

    const pendente = this.#pendentes.get(matchId)
    if (!pendente) return null

    const you = pendente.players[0] === address ? 0 : 1
    return {
      matchId,
      mode: pendente.mode,
      players: pendente.players,
      you,
      match: null,
      committed: this.#commits.get(matchId)?.[you] !== null,
    }
  }

  /** Lista para o painel de administração. */
  list(): { matchId: string; mode: GameModeId; phase: string; players: [string, string]; ageMs: number }[] {
    const agora = this.now()
    return [...this.#byId.entries()].map(([matchId, m]) => ({
      matchId,
      mode: m.mode,
      phase: m.phase,
      players: [m.players[0].address, m.players[1].address] as [string, string],
      ageMs: m.ageMs(agora),
    }))
  }

  /**
   * A sala fechou com os dois depósitos; a partida vai existir.
   *
   * Ainda não é uma `Match`: falta o compromisso dos dois com o nonce da
   * quebra. Guardar a intenção separada evita criar uma partida meio pronta
   * que o resto do código precise checar em todo lugar.
   */
  open(matchId: string, mode: GameModeId, players: [string, string]): void {
    // Reabrir apagaria os compromissos já enviados. Quem chama deve conferir
    // com `has`, mas a guarda fica aqui também porque o custo do erro é os
    // dois jogadores travarem até o prazo.
    if (this.has(matchId)) return

    this.#pendentes.set(matchId, { mode, players })
    this.#commits.set(matchId, [null, null])
    for (const p of players) this.#byPlayer.set(p, matchId)
    this.#emit({ t: 'begin', matchId, mode, players })
  }

  /** Recebe o compromisso de um jogador. Com os dois, a partida nasce. */
  commit(address: string, commit: string): void {
    const matchId = this.#byPlayer.get(address)
    const pendente = matchId ? this.#pendentes.get(matchId) : undefined
    if (!matchId || !pendente) {
      throw new MatchRuleError('unknown_player', 'Você não está em nenhuma partida.')
    }

    const quem = pendente.players[0] === address ? 0 : 1
    const commits = this.#commits.get(matchId)!
    if (commits[quem]) {
      throw new MatchRuleError('already_revealed', 'Você já se comprometeu.')
    }
    commits[quem] = commit

    if (!commits[0] || !commits[1]) return

    this.#byId.set(
      matchId,
      new Match(
        pendente.mode,
        [
          { address: pendente.players[0], cue: DEFAULT_CUE },
          { address: pendente.players[1], cue: DEFAULT_CUE },
        ],
        [commits[0], commits[1]],
        this.now(),
      ),
    )
    this.#pendentes.delete(matchId)
    this.#emit({ t: 'revealOpen', matchId })
    this.#ensureTimer()
  }

  reveal(address: string, nonce: Uint8Array): void {
    const { matchId, match } = this.#require(address)
    const comecou = match.reveal(address, nonce, this.now())
    if (comecou) {
      this.#emit({ t: 'start', matchId, seed: match.recorder!.seed })
      this.#afterAdvance(matchId, match)
    }
  }

  shoot(
    address: string,
    shot: { angle: number; power: number; spinX: number; spinY: number },
    call?: { ball: number; pocket: number },
  ): void {
    const { matchId, match } = this.#require(address)
    const view = match.shoot(address, shot, this.now(), call)
    this.#emit({ t: 'shot', matchId, view })
    this.#afterAdvance(matchId, match)
  }

  place(address: string, x: number, y: number): void {
    const { matchId, match } = this.#require(address)
    const quem = match.indexOf(address)!
    const onde = match.place(address, x, y, this.now())

    this.#emit({ t: 'placed', matchId, by: quem, x: onde.x, y: onde.y })
  }

  decide(address: string, option: number): void {
    const { matchId, match } = this.#require(address)
    const quem = match.indexOf(address)!
    const { rerack } = match.decide(address, option, this.now())

    this.#emit({ t: 'decided', matchId, chooser: quem, option, rerack })
    this.#afterAdvance(matchId, match)
  }

  forfeit(address: string): void {
    const { matchId, match } = this.#require(address)
    match.forfeit(address, this.now())
    this.#afterAdvance(matchId, match)
  }

  markOffline(address: string): void {
    const encontrado = this.matchOf(address)
    if (!encontrado) return
    encontrado.match.markOffline(address, this.now())
    const quem = encontrado.match.indexOf(address)
    if (quem !== null) this.#emit({ t: 'offline', matchId: encontrado.matchId, who: quem })
  }

  markOnline(address: string): void {
    const encontrado = this.matchOf(address)
    if (!encontrado) return
    encontrado.match.markOnline(address)
    const quem = encontrado.match.indexOf(address)
    if (quem !== null) this.#emit({ t: 'online', matchId: encontrado.matchId, who: quem })
  }

  /**
   * Confere os prazos de todas as partidas.
   *
   * Público para o teste chamar direto, com o tempo que quiser, sem depender
   * do intervalo real.
   */
  tick(): void {
    const agora = this.now()
    for (const [matchId, match] of [...this.#byId]) {
      // Uma partida que falhe não pode parar o relógio das outras. Isto roda
      // por temporizador: sem o isolamento, uma exceção sairia por um callback
      // que ninguém observa e TODAS as mesas congelariam, cada uma com
      // dinheiro no contrato.
      try {
        const r = match.tick(agora)
        if (!r.changed) continue

        // O relógio agiu no SERVIDOR. Sem repassar o que ele fez, a mesa dos
        // clientes fica no estado anterior para sempre — e com bola na mão a
        // branca continua encaçapada do lado deles, fazendo a física recusar a
        // tacada seguinte. Foi assim que a vez passar "quebrava o jogo".
        if (r.decided) {
          this.#emit({ t: 'decided', matchId, ...r.decided })
        }
        if (r.placed) {
          this.#emit({
            t: 'placed',
            matchId,
            by: r.view?.by ?? 0,
            x: r.placed.x,
            y: r.placed.y,
            byClock: true,
          })
        }
        if (r.view) {
          this.#emit({ t: 'shot', matchId, view: r.view, byClock: true })
        }

        this.#afterAdvance(matchId, match)
      } catch (err) {
        // Encerrar sem vencedor é o desfecho seguro: as entradas voltam pelo
        // prazo on-chain, em vez de a mesa ficar batendo o mesmo erro por
        // segundo até alguém perceber.
        this.onError?.(matchId, err)
        this.#abortar(matchId, match)
      }
    }
  }

  /** Avisado quando uma partida falha no relógio. */
  onError: ((matchId: string, err: unknown) => void) | null = null

  /** Tira do ar uma partida que não consegue mais avançar. */
  #abortar(matchId: string, match: Match): void {
    const players: [string, string] = [match.players[0].address, match.players[1].address]

    this.#byId.delete(matchId)
    this.#commits.delete(matchId)
    for (const p of players) this.#byPlayer.delete(p)

    this.#emit({
      t: 'end',
      matchId,
      players,
      result: { winner: null, reason: 'tempo', replay: new Uint8Array(0), nonces: null },
    })
  }

  /** Fecha tudo. Chamado quando o servidor para. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  // ------------------------------------------------------------- interno

  #afterAdvance(matchId: string, match: Match): void {
    if (match.phase === 'deciding') {
      this.#emit({ t: 'decision', matchId })
      return
    }
    if (match.phase === 'playing' && match.ballInHand !== null) {
      this.#emit({ t: 'ballInHand', matchId })
      return
    }
    if (match.phase === 'playing' && match.callRequired) {
      this.#emit({ t: 'callRequired', matchId })
    }
    if (match.phase !== 'finished') return

    const result = match.result()
    const players: [string, string] = [match.players[0].address, match.players[1].address]

    this.#byId.delete(matchId)
    this.#commits.delete(matchId)
    for (const p of players) this.#byPlayer.delete(p)
    if (this.#byId.size === 0) this.stop()

    // Emitido DEPOIS da limpeza: quem escuta pode querer abrir outra partida
    // para os mesmos jogadores, e eles precisam estar livres.
    if (result) this.#emit({ t: 'end', matchId, players, result })
  }

  #require(address: string): { matchId: string; match: Match } {
    const encontrado = this.matchOf(address)
    if (!encontrado?.match) {
      throw new MatchRuleError('unknown_player', 'Você não está em nenhuma partida.')
    }
    return encontrado
  }

  #ensureTimer(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.tick(), TICK_MS)
    // Não segura o processo vivo só por causa do relógio.
    this.#timer.unref?.()
  }
}
