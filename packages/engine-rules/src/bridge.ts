/**
 * Ponte entre a física e as regras.
 *
 * A física relata colisões; as regras perguntam "qual bola a branca tocou
 * primeiro?" e "alguma foi à tabela depois disso?". E, julgada a tacada, alguém
 * precisa devolver as bolas à mesa antes da próxima.
 *
 * Estas duas operações moram AQUI, num lugar só, porque elas decidem o
 * resultado da partida. Enquanto existiam duas cópias — uma no jogo, outra no
 * verificador de replay — bastava uma divergir para a auditoria passar a
 * apontar outro vencedor sem que nada acusasse o erro. Era o caso: o
 * verificador não devolvia as bolas à mesa, então toda partida de sinuca era
 * reproduzida errada.
 *
 * Regra para quem mexer aqui: se o jogo e o verificador não chamarem
 * exatamente a mesma função, o replay não prova nada.
 */

import {
  CUE_BALL,
  fixed as F,
  jitterFromSeed,
  rackBalls,
  table as T,
  vec as V,
  type CollisionEvent,
  type Fixed,
  type TableState,
} from '@zinc-pool/engine-physics'

/** Vocabulário que as regras entendem, extraído dos eventos da física. */
export type PhysicsOutcome = {
  firstContact: number | null
  pocketed: number[]
  offTable: number[]
  railAfterContact: boolean
  ballsToRail: number
  eightBallPocket: number | null
}

export function outcomeFromEvents(events: readonly CollisionEvent[]): PhysicsOutcome {
  let firstContact: number | null = null
  let contactIndex = -1

  // Primeiro contato: a primeira colisão entre bolas que envolve a branca.
  for (let i = 0; i < events.length; i++) {
    const evento = events[i]!
    if (evento.type !== 'ball-ball') continue
    if (evento.a !== CUE_BALL && evento.b !== CUE_BALL) continue

    firstContact = evento.a === CUE_BALL ? evento.b : evento.a
    contactIndex = i
    break
  }

  const pocketed: number[] = []
  let eightBallPocket: number | null = null
  let railAfterContact = false
  const bolasQueTocaramTabela = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    const evento = events[i]!

    if (evento.type === 'pocketed') {
      pocketed.push(evento.ball)
      if (evento.ball === 8) eightBallPocket = evento.pocket
      continue
    }

    if (evento.type === 'ball-cushion') {
      bolasQueTocaramTabela.add(evento.ball)
      // "Depois do contato" é literal: tabela antes de tocar bola não conta.
      if (contactIndex >= 0 && i > contactIndex) railAfterContact = true
    }
  }

  // Bolas NUMERADAS que foram à tabela — a branca não conta para a quebra.
  bolasQueTocaramTabela.delete(CUE_BALL)

  return {
    firstContact,
    pocketed,
    // A física prende as bolas dentro dos limites, então nada sai da mesa.
    // O campo existe porque as regras preveem o caso; o dia em que houver
    // tacada saltada, é aqui que ele passa a ser preenchido.
    offTable: [],
    railAfterContact,
    ballsToRail: bolasQueTocaramTabela.size,
    eightBallPocket,
  }
}

/**
 * O outcome completo que as modalidades recebem.
 *
 * `called` e `nominated` são decisões do JOGADOR, não da física, e por isso
 * entram por fora. Hoje ninguém as informa; quando a interface de declarar
 * caçapa existir, é por aqui que elas passam — e aí precisarão caber no replay,
 * senão a verificação diverge.
 */
export type ShotDeclarations = {
  called?: unknown
  nominated?: unknown
}

export function fullOutcome(
  physics: PhysicsOutcome,
  declarations: ShotDeclarations = {},
): PhysicsOutcome & { called: unknown; nominated: unknown } {
  // Cada modalidade lê campos diferentes; mandar todos é mais simples e mais
  // barato que ramificar — e mantém quem chama sem saber qual jogo é.
  return {
    ...physics,
    called: declarations.called ?? null,
    nominated: declarations.nominated ?? null,
  }
}

/**
 * Rearma o triângulo, no lugar.
 *
 * Usa o MESMO seed da partida, então a mesa remontada é idêntica à original —
 * inclusive o jitter. É o que precisa acontecer quando a escolha pós-quebra é
 * "quebrar de novo": as regras zeram as bolas encaçapadas, mas as bolas em si
 * continuam onde pararam até alguém chamar isto.
 *
 * Muta o objeto recebido em vez de devolver um novo porque o resto do jogo
 * guarda referências para as bolas.
 */
export function rerackTable(table: TableState, seed: Uint8Array): void {
  const nova = rackBalls(jitterFromSeed(seed))
  table.balls.length = 0
  table.balls.push(...nova.balls)
}

/**
 * Devolve as bolas à mesa depois do julgamento.
 *
 * Duas coisas acontecem, nesta ordem:
 *
 *   - a branca encaçapada volta ao ponto de saque
 *   - as bolas que o julgamento mandou devolver voltam ao ponto de pé
 *
 * A ordem não é indiferente: as duas posições são fixas e distintas, então
 * inverter não muda nada hoje — mas o dia em que houver empilhamento de bolas
 * devolvidas, muda. Fica explícita para não virar acidente.
 *
 * BOLA NA MÃO — quando o jogador tem direito de escolher onde pôr a branca, ela
 * NÃO é reposicionada aqui. Passe `ballInHand: true` e a branca fica marcada
 * como encaçapada até alguém chamar `placeCueBall`.
 *
 * Pôr no ponto canônico e deixar o jogador mover depois pareceria equivalente,
 * mas não é: o replay grava a posição ESCOLHIDA, e uma posição intermediária
 * que a física também tenha visto abre espaço para o jogo e o verificador
 * discordarem sobre o que aconteceu no meio.
 */
export function settleTable(
  table: TableState,
  ruling: unknown,
  options: { ballInHand?: boolean } = {},
): void {
  const branca = table.balls.find((b) => b.id === CUE_BALL)
  if (branca?.pocketed && !options.ballInHand) {
    branca.pocketed = false
    V.copy(branca.position, T.CUE_SPOT)
    V.set(branca.velocity, 0, 0)
    V.set(branca.spin, 0, 0)
  }

  const respot = (ruling as { respot?: number[] } | null)?.respot ?? []
  for (const id of respot) {
    const bola = table.balls.find((b) => b.id === id)
    if (!bola?.pocketed) continue

    bola.pocketed = false
    V.copy(bola.position, T.FOOT_SPOT)
    V.set(bola.velocity, 0, 0)
    V.set(bola.spin, 0, 0)
  }
}

/**
 * Põe a branca onde o jogador escolheu.
 *
 * A posição é presa aos limites da mesa aqui, num lugar só: se cada ponta
 * prendesse do seu jeito, uma coordenada logo fora da borda viraria posições
 * diferentes no jogo e no verificador.
 */
export function placeCueBall(table: TableState, x: Fixed, y: Fixed): void {
  const branca = table.balls.find((b) => b.id === CUE_BALL)
  if (!branca) return

  branca.pocketed = false
  V.set(
    branca.position,
    F.clamp(x, T.BALL_RADIUS, T.WIDTH - T.BALL_RADIUS),
    F.clamp(y, T.BALL_RADIUS, T.HEIGHT - T.BALL_RADIUS),
  )
  V.set(branca.velocity, 0, 0)
  V.set(branca.spin, 0, 0)
}
