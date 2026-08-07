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
  /** Bola e caçapa prometidas antes da tacada. */
  called?: { ball: number; pocket: number } | null
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

/** Quantas passadas de separação. Sete resolvem qualquer aglomerado real. */
const PASSADAS_DE_SEPARACAO = 7

/**
 * Põe a branca onde o jogador escolheu.
 *
 * Duas correções acontecem aqui, e as duas precisam estar NESTE arquivo: se
 * cada ponta ajustasse do seu jeito, a mesma coordenada viraria posições
 * diferentes no jogo e no verificador.
 *
 *   - a posição é presa aos limites da mesa
 *   - a branca é afastada de qualquer bola em que tenha sido largada em cima
 *
 * A segunda existe porque sobrepor era possível e não devia ser: a simulação
 * começaria resolvendo uma colisão que nunca aconteceu, e as duas bolas
 * saltariam sozinhas antes da tacada.
 *
 * O afastamento é determinístico — ordem fixa por id, número fixo de passadas,
 * tudo em ponto fixo — porque o verificador precisa chegar ao mesmo lugar.
 */
export function placeCueBall(table: TableState, x: Fixed, y: Fixed): void {
  const branca = table.balls.find((b) => b.id === CUE_BALL)
  if (!branca) return

  branca.pocketed = false
  V.set(branca.position, dentroDaMesa(x, T.WIDTH), dentroDaMesa(y, T.HEIGHT))
  V.set(branca.velocity, 0, 0)
  V.set(branca.spin, 0, 0)

  separarDasOutras(table, branca)
}

const dentroDaMesa = (valor: Fixed, extensao: Fixed): Fixed =>
  F.clamp(valor, T.BALL_RADIUS, extensao - T.BALL_RADIUS)

/**
 * Empurra a branca para fora de qualquer bola que ela esteja tocando.
 *
 * Repete algumas vezes porque afastar de uma bola pode encostar em outra —
 * caso comum ao largar a branca no meio do aglomerado depois da quebra.
 */
function separarDasOutras(table: TableState, branca: TableState['balls'][number]): void {
  const outras = table.balls
    .filter((b) => b.id !== CUE_BALL && !b.pocketed)
    // Ordem fixa: com posições sobrepostas, a ordem muda o resultado, e o
    // verificador precisa percorrer exatamente a mesma.
    .sort((a, b) => a.id - b.id)

  for (let passada = 0; passada < PASSADAS_DE_SEPARACAO; passada++) {
    let mexeu = false

    for (const outra of outras) {
      const dx = branca.position.x - outra.position.x
      const dy = branca.position.y - outra.position.y
      const distancia = F.sqrt(F.mul(dx, dx) + F.mul(dy, dy))

      if (distancia >= T.CONTACT_DISTANCE) continue

      // Largada exatamente em cima: sem direção para empurrar, usa +x. Precisa
      // ser uma escolha FIXA, não a primeira que der certo.
      const [ux, uy] =
        distancia === 0
          ? [F.ONE, 0]
          : [F.div(dx, distancia), F.div(dy, distancia)]

      V.set(
        branca.position,
        dentroDaMesa(outra.position.x + F.mul(ux, T.CONTACT_DISTANCE), T.WIDTH),
        dentroDaMesa(outra.position.y + F.mul(uy, T.CONTACT_DISTANCE), T.HEIGHT),
      )
      mexeu = true
    }

    if (!mexeu) return
  }
}

/**
 * Devolve bolas ao ponto de pé, fora do julgamento de uma tacada.
 *
 * Usado pelas escolhas que recolocam bola sem haver tacada — hoje só o
 * "recolocar a 8" do 8-Ball. É a mesma operação que `settleTable` faz com o
 * `respot` do julgamento, e mora aqui pelo mesmo motivo: jogo e verificador
 * precisam chamar exatamente a mesma função.
 */
export function respotBalls(table: TableState, ids: readonly number[]): void {
  for (const id of ids) {
    const bola = table.balls.find((b) => b.id === id)
    if (!bola?.pocketed) continue

    bola.pocketed = false
    V.copy(bola.position, T.FOOT_SPOT)
    V.set(bola.velocity, 0, 0)
    V.set(bola.spin, 0, 0)
  }
}
