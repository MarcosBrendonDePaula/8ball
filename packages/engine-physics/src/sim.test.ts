import { describe, expect, test } from 'bun:test'
import * as F from './fixed'
import * as S from './sim'
import * as T from './table'
import * as V from './vec'

/**
 * Estes testes são o contrato da engine. Cada um checa uma propriedade que, se
 * quebrar, quebra a partida: bola não atravessa bola, energia não aparece do
 * nada, e a mesma tacada dá o mesmo resultado sempre.
 */

const n = (v: F.Fixed) => F.toNumber(v)
const perto = (a: number, b: number, tol = 1e-2) => Math.abs(a - b) < tol

function mesa(...bolas: Array<{ x: number; y: number; vx?: number; vy?: number }>): S.TableState {
  return {
    balls: bolas.map((b, i) => {
      const bola = S.createBall(i, F.from(b.x), F.from(b.y))
      V.set(bola.velocity, F.from(b.vx ?? 0), F.from(b.vy ?? 0))
      return bola
    }),
  }
}

const energia = (estado: S.TableState): number =>
  estado.balls
    .filter((b) => !b.pocketed)
    .reduce((soma, b) => soma + n(V.lengthSq(b.velocity)), 0)

/** Hash do estado, para comparar execuções bit a bit. */
const hash = (estado: S.TableState): string =>
  estado.balls.map((b) => `${b.id}:${b.position.x},${b.position.y},${b.pocketed}`).join('|')

describe('movimento', () => {
  test('bola parada continua parada', () => {
    const estado = mesa({ x: 0.5, y: 0.5 })
    S.simulate(estado)

    expect(perto(n(estado.balls[0]!.position.x), 0.5)).toBe(true)
    expect(perto(n(estado.balls[0]!.position.y), 0.5)).toBe(true)
  })

  test('bola em movimento anda na direção da velocidade', () => {
    const estado = mesa({ x: 0.3, y: 0.5, vx: 1 })
    S.step(estado)

    expect(estado.balls[0]!.position.x).toBeGreaterThan(F.from(0.3))
    expect(perto(n(estado.balls[0]!.position.y), 0.5)).toBe(true)
  })

  test('atrito faz a bola parar sozinha', () => {
    const estado = mesa({ x: 0.3, y: 0.5, vx: 1.5 })
    S.simulate(estado)

    expect(S.isMoving(estado)).toBe(false)
    expect(V.isZero(estado.balls[0]!.velocity)).toBe(true)
  })

  test('tacada mais forte percorre distância maior', () => {
    // Mede o CAMINHO, não o deslocamento: com força suficiente a bola quica na
    // tabela e volta, terminando perto de onde saiu.
    const caminho = (velocidade: number) => {
      const estado = mesa({ x: 0.2, y: 0.5, vx: velocidade })
      let total = 0
      let anterior = V.clone(estado.balls[0]!.position)

      for (let i = 0; i < T.MAX_STEPS && S.isMoving(estado); i++) {
        S.step(estado)
        total += n(V.distance(anterior, estado.balls[0]!.position))
        anterior = V.clone(estado.balls[0]!.position)
      }
      return total
    }

    expect(caminho(2)).toBeGreaterThan(caminho(1))
    expect(caminho(1)).toBeGreaterThan(caminho(0.5))
  })
})

describe('tabelas', () => {
  test('bola quica e inverte o sentido', () => {
    const estado = mesa({ x: 1.8, y: 0.5, vx: 2 })
    S.simulate(estado)

    // Terminou dentro da mesa e voltou para a esquerda em algum momento.
    expect(T.isInsideBounds(estado.balls[0]!.position)).toBe(true)
    expect(n(estado.balls[0]!.position.x)).toBeLessThan(1.98)
  })

  test('quicar perde energia, nunca ganha', () => {
    const estado = mesa({ x: 1.8, y: 0.5, vx: 3 })
    const inicial = energia(estado)
    S.step(estado)

    expect(energia(estado)).toBeLessThanOrEqual(inicial + 1e-6)
  })

  test('nenhuma bola sai da mesa, nem em velocidade absurda', () => {
    const estado = mesa(
      { x: 0.5, y: 0.5, vx: 15, vy: 11 },
      { x: 1.5, y: 0.4, vx: -13, vy: -9 },
    )

    for (let i = 0; i < 2_000 && S.isMoving(estado); i++) {
      S.step(estado)
      for (const bola of estado.balls) {
        if (bola.pocketed) continue
        expect(T.isInsideBounds(bola.position)).toBe(true)
      }
    }
  })

  test('emite evento ao tocar a tabela', () => {
    const estado = mesa({ x: 1.9, y: 0.5, vx: 2 })
    const eventos = S.simulate(estado)

    expect(eventos.some((e) => e.type === 'ball-cushion')).toBe(true)
  })
})

describe('colisão entre bolas', () => {
  test('choque frontal transfere o movimento', () => {
    // Clássico: branca bate na parada, para, e a outra sai.
    const estado = mesa({ x: 0.5, y: 0.5, vx: 2 }, { x: 0.8, y: 0.5 })
    S.simulate(estado)

    const [branca, objeto] = estado.balls as [S.Ball, S.Ball]
    expect(n(objeto.position.x)).toBeGreaterThan(0.8)
    expect(n(branca.position.x)).toBeLessThan(n(objeto.position.x))
  })

  test('bolas nunca se sobrepõem', () => {
    const estado = mesa(
      { x: 0.4, y: 0.5, vx: 9 },
      { x: 0.9, y: 0.5 },
      { x: 1.0, y: 0.55 },
      { x: 1.1, y: 0.45 },
    )

    for (let passo = 0; passo < 2_000 && S.isMoving(estado); passo++) {
      S.step(estado)

      const ativas = estado.balls.filter((b) => !b.pocketed)
      for (let i = 0; i < ativas.length; i++) {
        for (let j = i + 1; j < ativas.length; j++) {
          const separacao = n(V.distance(ativas[i]!.position, ativas[j]!.position))
          // Tolerância mínima para o arredondamento de Q16.16.
          expect(separacao).toBeGreaterThan(n(T.CONTACT_DISTANCE) - 1e-3)
        }
      }
    }
  })

  test('bola rápida não atravessa a parada — a razão de existir colisão contínua', () => {
    // A 14 m/s a bola anda 5.8cm por passo, o dobro do próprio diâmetro.
    // Com detecção por sobreposição, ela passaria direto.
    const estado = mesa({ x: 0.3, y: 0.5, vx: 14 }, { x: 0.6, y: 0.5 })
    const eventos = S.simulate(estado)

    expect(eventos.some((e) => e.type === 'ball-ball')).toBe(true)
    expect(V.isZero(estado.balls[1]!.velocity)).toBe(true)
    expect(n(estado.balls[1]!.position.x)).toBeGreaterThan(0.6)
  })

  test('colisão não cria energia', () => {
    const estado = mesa({ x: 0.4, y: 0.5, vx: 4 }, { x: 0.7, y: 0.52 })
    const inicial = energia(estado)
    S.simulate(estado)

    expect(energia(estado)).toBeLessThanOrEqual(inicial)
  })

  test('choque de raspão desvia as duas', () => {
    const estado = mesa({ x: 0.4, y: 0.5, vx: 3 }, { x: 0.75, y: 0.53 })
    S.simulate(estado)

    // A branca não segue em linha reta: ganhou componente em y.
    expect(Math.abs(n(estado.balls[0]!.position.y) - 0.5)).toBeGreaterThan(1e-3)
    expect(Math.abs(n(estado.balls[1]!.position.y) - 0.53)).toBeGreaterThan(1e-3)
  })

  test('bolas paradas em contato não disparam colisões infinitas', () => {
    const estado = mesa(
      { x: 0.5, y: 0.5 },
      { x: 0.5 + n(T.CONTACT_DISTANCE), y: 0.5 },
    )
    const eventos = S.simulate(estado)

    expect(eventos).toHaveLength(0)
    expect(S.isMoving(estado)).toBe(false)
  })
})

describe('caçapas', () => {
  test('bola que chega na caçapa é encaçapada', () => {
    const estado = mesa({ x: 0.3, y: 0.3, vx: -2, vy: -2 })
    const eventos = S.simulate(estado)

    expect(estado.balls[0]!.pocketed).toBe(true)
    expect(eventos.some((e) => e.type === 'pocketed')).toBe(true)
  })

  test('bola encaçapada sai da simulação', () => {
    const estado = mesa({ x: 0.1, y: 0.1, vx: -1, vy: -1 }, { x: 1.0, y: 0.5, vx: 1 })
    S.simulate(estado)

    expect(estado.balls[0]!.pocketed).toBe(true)
    expect(V.isZero(estado.balls[0]!.velocity)).toBe(true)
    // A outra seguiu normalmente.
    expect(estado.balls[1]!.pocketed).toBe(false)
  })

  test('bola no meio da mesa não é encaçapada', () => {
    const estado = mesa({ x: 0.99, y: 0.5, vx: 0.5 })
    S.simulate(estado)
    expect(estado.balls[0]!.pocketed).toBe(false)
  })

  test('caçapa do meio captura', () => {
    const meio = n(T.POCKETS[1]!.center.x)
    const estado = mesa({ x: meio, y: 0.2, vy: -2 })
    S.simulate(estado)

    expect(estado.balls[0]!.pocketed).toBe(true)
  })
})

describe('determinismo', () => {
  test('a mesma tacada dá exatamente o mesmo resultado', () => {
    const montar = () =>
      mesa(
        { x: 0.4, y: 0.5, vx: 7, vy: 1.3 },
        { x: 1.2, y: 0.5 },
        { x: 1.26, y: 0.53 },
        { x: 1.26, y: 0.47 },
        { x: 1.32, y: 0.56 },
        { x: 1.32, y: 0.5 },
      )

    const a = montar()
    const b = montar()
    S.simulate(a)
    S.simulate(b)

    expect(hash(a)).toBe(hash(b))
  })

  test('a sequência de eventos é idêntica', () => {
    const montar = () =>
      mesa({ x: 0.35, y: 0.45, vx: 9, vy: 2.1 }, { x: 1.1, y: 0.5 }, { x: 1.4, y: 0.62 })

    const primeira = JSON.stringify(S.simulate(montar()))
    const segunda = JSON.stringify(S.simulate(montar()))

    expect(primeira).toBe(segunda)
  })

  test('simular em um passo grande ou em vários pequenos não diverge do próprio hash', () => {
    // Não é o mesmo resultado (dt diferente é física diferente), mas cada um
    // precisa ser reproduzível sozinho.
    const rodarCom = (dt: F.Fixed) => {
      const estado = mesa({ x: 0.4, y: 0.5, vx: 5 }, { x: 1.0, y: 0.5 })
      for (let i = 0; i < 500 && S.isMoving(estado); i++) S.step(estado, dt)
      return hash(estado)
    }
    expect(rodarCom(T.DT)).toBe(rodarCom(T.DT))
    expect(rodarCom(F.div(F.ONE, F.fromInt(120)))).toBe(rodarCom(F.div(F.ONE, F.fromInt(120))))
  })

  test('nenhuma posição sai da faixa segura de ponto fixo', () => {
    const estado = mesa(
      { x: 0.3, y: 0.3, vx: 14, vy: 10 },
      { x: 1.5, y: 0.7, vx: -12, vy: -8 },
      { x: 0.9, y: 0.5 },
    )

    for (let i = 0; i < 3_000 && S.isMoving(estado); i++) {
      S.step(estado)
      for (const bola of estado.balls) {
        expect(() => V.check(bola.position)).not.toThrow()
        expect(() => V.check(bola.velocity)).not.toThrow()
      }
    }
  })

  test('a simulação sempre termina', () => {
    const estado = mesa(
      ...Array.from({ length: 16 }, (_, i) => ({
        x: 0.3 + (i % 4) * 0.35,
        y: 0.25 + Math.floor(i / 4) * 0.16,
        vx: i === 0 ? 12 : 0,
        vy: i === 0 ? 3 : 0,
      })),
    )

    let passos = 0
    while (S.isMoving(estado) && passos < T.MAX_STEPS) {
      S.step(estado)
      passos++
    }
    expect(passos).toBeLessThan(T.MAX_STEPS)
    expect(S.isMoving(estado)).toBe(false)
  })
})

describe('estado', () => {
  test('cloneState é cópia profunda', () => {
    const original = mesa({ x: 0.5, y: 0.5, vx: 1 })
    const copia = S.cloneState(original)

    V.set(copia.balls[0]!.position, 0, 0)
    expect(V.isZero(original.balls[0]!.position)).toBe(false)
  })

  test('isMoving ignora bolas encaçapadas', () => {
    const estado = mesa({ x: 0.5, y: 0.5, vx: 1 })
    estado.balls[0]!.pocketed = true
    expect(S.isMoving(estado)).toBe(false)
  })
})
