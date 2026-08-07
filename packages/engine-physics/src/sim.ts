import * as F from './fixed'
import type { Fixed } from './fixed'
import * as T from './table'
import * as V from './vec'
import type { Vec } from './vec'

/**
 * Simulação determinística da mesa.
 *
 * DECISÃO CENTRAL — colisão contínua, não discreta. Uma bola a 12 m/s percorre
 * 5cm num passo de 1/240s, quase o dobro do próprio diâmetro: com detecção por
 * sobreposição ela atravessaria a outra sem tocar. Aqui, cada passo calcula o
 * instante exato do primeiro contato, avança até ele, resolve, e continua com
 * o tempo que sobrou. Nenhuma bola atravessa outra, em nenhuma velocidade.
 *
 * Nada de `Math.random` nem `Date`: a mesma entrada produz a mesma saída em
 * qualquer máquina, hoje ou daqui a anos.
 */

export type Ball = {
  id: number
  position: Vec
  velocity: Vec
  /**
   * Efeito. `x` é o lateral (inglês), `y` é o vertical: positivo puxa a bola
   * para frente depois do contato, negativo faz recuar.
   *
   * Modelo simplificado de propósito. Rotação real exigiria momento angular e
   * atrito de contato, e o custo disso não se paga: o que o jogador percebe é
   * a branca correr, recuar ou abrir depois de bater — e é isso que está aqui.
   */
  spin: Vec
  /**
   * Quanto do efeito sobra a cada passo. Vem do taco (aderência do couro) e
   * viaja com a bola porque é o efeito DELA que está decaindo.
   */
  spinDecay: Fixed
  /** Encaçapada sai da mesa e para de participar da simulação. */
  pocketed: boolean
}

export type TableState = {
  balls: Ball[]
}

export type CollisionEvent =
  | { type: 'ball-ball'; a: number; b: number; speed: Fixed }
  | { type: 'ball-cushion'; ball: number; cushion: T.Cushion; speed: Fixed }
  | { type: 'pocketed'; ball: number; pocket: number }

export function createBall(id: number, x: Fixed, y: Fixed): Ball {
  return {
    id,
    position: V.vec(x, y),
    velocity: V.vec(0, 0),
    spin: V.vec(0, 0),
    spinDecay: T.SPIN_DECAY,
    pocketed: false,
  }
}

export function cloneState(state: TableState): TableState {
  return {
    balls: state.balls.map((b) => ({
      id: b.id,
      position: V.clone(b.position),
      velocity: V.clone(b.velocity),
      spin: V.clone(b.spin),
      spinDecay: b.spinDecay,
      pocketed: b.pocketed,
    })),
  }
}

/** Alguma bola ainda está em movimento? */
export function isMoving(state: TableState): boolean {
  for (const ball of state.balls) {
    if (!ball.pocketed && !V.isZero(ball.velocity)) return true
  }
  return false
}

// --------------------------------------------------- tempo até o contato

/** Nenhum contato dentro do intervalo. */
const NO_HIT = -1

/**
 * Instante em que duas bolas se tocam, dentro de `limite`.
 *
 * Resolve |d + v·t| = 2R para t. Só interessa a raiz menor (primeiro contato)
 * e apenas quando elas estão se aproximando — bolas em contato que já se
 * separam não devem colidir de novo e travar a simulação.
 */
function timeToBallContact(a: Ball, b: Ball, limite: Fixed): Fixed {
  const d = V.sub(b.position, a.position)
  const v = V.sub(b.velocity, a.velocity)

  const vv = V.lengthSq(v)
  if (vv === 0) return NO_HIT

  const dv = V.dot(d, v)
  if (dv >= 0) return NO_HIT // afastando-se

  const dd = V.lengthSq(d)
  const c = dd - T.CONTACT_DISTANCE_SQ

  // Já sobrepostas e se aproximando: resolve agora, senão afundam uma na outra.
  if (c <= 0) return 0

  const discriminante = F.sqr(dv) - F.mul(vv, c)
  if (discriminante < 0) return NO_HIT

  const t = F.div(-dv - F.sqrt(discriminante), vv)
  return t >= 0 && t <= limite ? t : NO_HIT
}

/** Instante em que a bola toca uma tabela, e qual. */
function timeToCushionContact(
  ball: Ball,
  limite: Fixed,
): { time: Fixed; cushion: T.Cushion } | null {
  let melhor: { time: Fixed; cushion: T.Cushion } | null = null

  const considerar = (time: Fixed, cushion: T.Cushion) => {
    if (time < 0 || time > limite) return
    if (!melhor || time < melhor.time) melhor = { time, cushion }
  }

  const { position: p, velocity: v } = ball

  if (v.x < 0) considerar(F.div(T.CUSHION_BOUNDS.minX - p.x, v.x), T.Cushion.Left)
  if (v.x > 0) considerar(F.div(T.CUSHION_BOUNDS.maxX - p.x, v.x), T.Cushion.Right)
  if (v.y < 0) considerar(F.div(T.CUSHION_BOUNDS.minY - p.y, v.y), T.Cushion.Bottom)
  if (v.y > 0) considerar(F.div(T.CUSHION_BOUNDS.maxY - p.y, v.y), T.Cushion.Top)

  return melhor
}

// -------------------------------------------------------------- resolução

/**
 * Colisão elástica entre bolas de massa igual.
 *
 * Só a componente ao longo da linha de centros é trocada; a tangencial passa
 * intacta. É o que faz a bola objeto sair na direção do contato e a branca
 * desviar — o comportamento que todo jogador de sinuca conhece.
 */
function resolveBallCollision(a: Ball, b: Ball): Fixed {
  const normal = V.normalize(V.sub(b.position, a.position))
  if (V.isZero(normal)) return 0

  const relativa = V.sub(b.velocity, a.velocity)
  const aproximacao = V.dot(relativa, normal)
  if (aproximacao >= 0) return 0

  // Massas iguais: cada uma leva metade da troca, amortecida pela restituição.
  const impulso = F.mul(aproximacao, T.BALL_RESTITUTION)

  a.velocity.x += F.mul(impulso, normal.x)
  a.velocity.y += F.mul(impulso, normal.y)
  b.velocity.x -= F.mul(impulso, normal.x)
  b.velocity.y -= F.mul(impulso, normal.y)

  // Efeito vertical: quem chegou com rotação corre atrás da bola (topspin) ou
  // recua (backspin). É o que dá controle de posição para a próxima tacada.
  aplicarEfeitoVertical(a, normal)
  aplicarEfeitoVertical(b, V.neg(normal))

  return F.abs(aproximacao)
}

/**
 * Transfere o efeito vertical para velocidade ao longo da linha de contato.
 *
 * Gasta o efeito no processo: uma tacada com recuo não recua duas vezes.
 */
function aplicarEfeitoVertical(ball: Ball, direcao: Vec): void {
  if (ball.spin.y === 0) return

  const transferido = F.mul(ball.spin.y, T.SPIN_TRANSFER)
  ball.velocity.x += F.mul(direcao.x, transferido)
  ball.velocity.y += F.mul(direcao.y, transferido)

  ball.spin.y = F.mul(ball.spin.y, T.SPIN_RETENTION)
}

function resolveCushionCollision(ball: Ball, cushion: T.Cushion): Fixed {
  const eixoX = cushion === T.Cushion.Left || cushion === T.Cushion.Right
  const velocidade = F.abs(eixoX ? ball.velocity.x : ball.velocity.y)

  // Efeito lateral muda o ÂNGULO de saída: a bola abre ou fecha em relação ao
  // que a reflexão pura daria. É o recurso que permite escapar de snookers.
  const desvio = F.mul(ball.spin.x, T.SPIN_CUSHION_EFFECT)

  if (eixoX) {
    ball.velocity.x = -F.mul(ball.velocity.x, T.CUSHION_RESTITUTION)
    ball.velocity.y += desvio
    // Cola no limite: sem isto, erro de arredondamento deixa a bola um passo
    // fora e ela dispara outra colisão imediatamente.
    ball.position.x =
      cushion === T.Cushion.Left ? T.CUSHION_BOUNDS.minX : T.CUSHION_BOUNDS.maxX
  } else {
    ball.velocity.y = -F.mul(ball.velocity.y, T.CUSHION_RESTITUTION)
    ball.velocity.x += desvio
    ball.position.y =
      cushion === T.Cushion.Bottom ? T.CUSHION_BOUNDS.minY : T.CUSHION_BOUNDS.maxY
  }

  ball.spin.x = F.mul(ball.spin.x, T.SPIN_RETENTION)

  return velocidade
}

// ------------------------------------------------------------- integração

function advance(state: TableState, dt: Fixed): void {
  for (const ball of state.balls) {
    if (ball.pocketed || V.isZero(ball.velocity)) continue
    V.addScaledInto(ball.position, ball.velocity, dt)
  }
}

/** Aplica atrito e zera quem já está praticamente parado. */
function applyFriction(state: TableState, dt: Fixed): void {
  const perda = F.mul(T.ROLLING_FRICTION, dt)

  for (const ball of state.balls) {
    if (ball.pocketed || V.isZero(ball.velocity)) continue

    const velocidade = V.length(ball.velocity)
    if (velocidade <= perda || velocidade < T.REST_SPEED) {
      V.set(ball.velocity, 0, 0)
      continue
    }

    const fator = F.div(velocidade - perda, velocidade)
    V.scaleInto(ball.velocity, ball.velocity, fator)

    // O pano também come o efeito, senão ele duraria a tacada inteira.
    // A taxa vem do taco: couro mais aderente segura o efeito por mais tempo.
    V.scaleInto(ball.spin, ball.spin, ball.spinDecay)
  }
}

function capturePockets(state: TableState, events: CollisionEvent[]): void {
  for (const ball of state.balls) {
    if (ball.pocketed) continue

    const pocket = T.pocketAt(ball.position)
    if (pocket < 0) continue

    ball.pocketed = true
    V.set(ball.velocity, 0, 0)
    V.set(ball.spin, 0, 0)
    events.push({ type: 'pocketed', ball: ball.id, pocket })
  }
}

/**
 * Avança um passo de tempo, resolvendo colisões na ordem em que acontecem.
 *
 * O laço interno existe porque um único passo pode conter várias colisões — na
 * quebra, dezenas. Resolver todas na ordem correta é o que separa uma
 * simulação plausível de uma que empurra bolas para dentro umas das outras.
 */
export function step(state: TableState, dt: Fixed = T.DT): CollisionEvent[] {
  const events: CollisionEvent[] = []
  let restante = dt

  // Teto de resoluções por passo. Uma quebra bem no meio gera muitas, mas
  // centenas indicariam bug — e o laço precisa terminar de qualquer forma.
  for (let iteracao = 0; iteracao < 64 && restante > 0; iteracao++) {
    let menorTempo = restante
    let colisao: CollisionEvent | null = null
    let parA: Ball | null = null
    let parB: Ball | null = null
    let tabela: T.Cushion | null = null

    const ativas = state.balls.filter((b) => !b.pocketed)

    for (let i = 0; i < ativas.length; i++) {
      const a = ativas[i]!

      const contatoTabela = timeToCushionContact(a, menorTempo)
      if (contatoTabela && contatoTabela.time < menorTempo) {
        menorTempo = contatoTabela.time
        colisao = { type: 'ball-cushion', ball: a.id, cushion: contatoTabela.cushion, speed: 0 }
        parA = a
        parB = null
        tabela = contatoTabela.cushion
      }

      for (let j = i + 1; j < ativas.length; j++) {
        const b = ativas[j]!
        const t = timeToBallContact(a, b, menorTempo)
        if (t !== NO_HIT && t < menorTempo) {
          menorTempo = t
          colisao = { type: 'ball-ball', a: a.id, b: b.id, speed: 0 }
          parA = a
          parB = b
          tabela = null
        }
      }
    }

    advance(state, menorTempo)
    restante -= menorTempo

    if (!colisao) break

    if (colisao.type === 'ball-ball' && parA && parB) {
      const velocidade = resolveBallCollision(parA, parB)
      events.push({ ...colisao, speed: velocidade })
    } else if (colisao.type === 'ball-cushion' && parA && tabela !== null) {
      const velocidade = resolveCushionCollision(parA, tabela)
      events.push({ ...colisao, speed: velocidade })
    }

    capturePockets(state, events)
  }

  capturePockets(state, events)
  applyFriction(state, dt)

  return events
}

/**
 * Roda até todas as bolas pararem.
 *
 * Devolve os eventos em ordem — é o que o cliente usa para som e animação, e o
 * que entra no hash do resultado.
 */
export function simulate(state: TableState, maxSteps = T.MAX_STEPS): CollisionEvent[] {
  const events: CollisionEvent[] = []

  for (let i = 0; i < maxSteps && isMoving(state); i++) {
    events.push(...step(state))
  }
  return events
}
