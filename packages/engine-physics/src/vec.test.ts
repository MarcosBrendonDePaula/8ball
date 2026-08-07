import { describe, expect, test } from 'bun:test'
import * as F from './fixed'
import * as V from './vec'

const perto = (a: number, b: number, tolerancia = 1e-3) => Math.abs(a - b) < tolerancia
const n = (v: F.Fixed) => F.toNumber(v)

describe('construção', () => {
  test('cria, copia e compara', () => {
    const a = V.fromNumbers(1.5, -2.25)
    const b = V.clone(a)

    expect(V.equals(a, b)).toBe(true)
    expect(perto(n(a.x), 1.5)).toBe(true)
    expect(perto(n(a.y), -2.25)).toBe(true)

    V.set(b, 0, 0)
    expect(V.isZero(b)).toBe(true)
    // Clone é cópia de verdade: mexer em b não mexe em a.
    expect(V.isZero(a)).toBe(false)
  })
})

describe('operações', () => {
  test('soma e subtração', () => {
    const a = V.fromNumbers(1, 2)
    const b = V.fromNumbers(3, -4)

    expect(V.equals(V.add(a, b), V.fromNumbers(4, -2))).toBe(true)
    expect(V.equals(V.sub(a, b), V.fromNumbers(-2, 6))).toBe(true)
  })

  test('escala', () => {
    const v = V.scale(V.fromNumbers(2, -3), F.from(2.5))
    expect(perto(n(v.x), 5)).toBe(true)
    expect(perto(n(v.y), -7.5)).toBe(true)
  })

  test('addScaledInto acumula no destino', () => {
    const pos = V.fromNumbers(1, 1)
    const vel = V.fromNumbers(2, -1)
    V.addScaledInto(pos, vel, F.from(0.5))

    expect(perto(n(pos.x), 2)).toBe(true)
    expect(perto(n(pos.y), 0.5)).toBe(true)
  })

  test('produto escalar', () => {
    expect(perto(n(V.dot(V.fromNumbers(1, 2), V.fromNumbers(3, 4))), 11)).toBe(true)
    // Perpendiculares dão zero — base de toda decomposição de colisão.
    expect(V.dot(V.fromNumbers(1, 0), V.fromNumbers(0, 1))).toBe(0)
  })

  test('produto vetorial indica o lado', () => {
    expect(V.cross(V.fromNumbers(1, 0), V.fromNumbers(0, 1))).toBeGreaterThan(0)
    expect(V.cross(V.fromNumbers(1, 0), V.fromNumbers(0, -1))).toBeLessThan(0)
    expect(V.cross(V.fromNumbers(2, 2), V.fromNumbers(4, 4))).toBe(0)
  })

  test('perp é perpendicular e preserva o comprimento', () => {
    const v = V.fromNumbers(3, 4)
    const p = V.perp(v)

    expect(V.dot(v, p)).toBe(0)
    expect(perto(n(V.length(p)), 5)).toBe(true)
  })
})

describe('comprimento e distância', () => {
  test('triângulo 3-4-5', () => {
    expect(perto(n(V.length(V.fromNumbers(3, 4))), 5)).toBe(true)
    expect(perto(n(V.lengthSq(V.fromNumbers(3, 4))), 25)).toBe(true)
  })

  test('distância entre pontos', () => {
    const a = V.fromNumbers(1, 1)
    const b = V.fromNumbers(4, 5)
    expect(perto(n(V.distance(a, b)), 5)).toBe(true)
    expect(perto(n(V.distanceSq(a, b)), 25)).toBe(true)
  })

  test('distanceSq preserva a ordem de distance', () => {
    // A simulação compara distâncias sem tirar raiz; se a ordem divergisse,
    // a detecção de colisão escolheria o par errado.
    const origem = V.fromNumbers(0, 0)
    const pontos = [
      V.fromNumbers(1, 0),
      V.fromNumbers(0.5, 0.5),
      V.fromNumbers(3, 4),
      V.fromNumbers(0.1, 0.1),
    ]
    const porQuadrado = [...pontos].sort((a, b) => V.distanceSq(origem, a) - V.distanceSq(origem, b))
    const porDistancia = [...pontos].sort((a, b) => V.distance(origem, a) - V.distance(origem, b))
    expect(porQuadrado).toEqual(porDistancia)
  })
})

describe('normalização', () => {
  test('resulta em comprimento unitário', () => {
    for (const [x, y] of [[3, 4], [1, 0], [0, -7], [-2, 5]] as const) {
      const u = V.normalize(V.fromNumbers(x, y))
      expect(perto(n(V.length(u)), 1, 1e-2)).toBe(true)
    }
  })

  test('preserva a direção', () => {
    const v = V.fromNumbers(6, 8)
    const u = V.normalize(v)
    // Paralelos: produto vetorial ~ 0.
    expect(Math.abs(n(V.cross(v, u)))).toBeLessThan(1e-2)
  })

  test('vetor nulo continua nulo, não vira NaN', () => {
    const u = V.normalize(V.vec(0, 0))
    expect(V.isZero(u)).toBe(true)
    expect(Number.isInteger(u.x)).toBe(true)
  })
})

describe('ângulo', () => {
  test('fromAngle dá vetor unitário na direção certa', () => {
    for (const grau of [0, 45, 90, 180, 270]) {
      const rad = (grau * Math.PI) / 180
      const v = V.fromAngle(F.from(rad))
      expect(perto(n(v.x), Math.cos(rad), 1e-2)).toBe(true)
      expect(perto(n(v.y), Math.sin(rad), 1e-2)).toBe(true)
      expect(perto(n(V.length(v)), 1, 1e-2)).toBe(true)
    }
  })
})

describe('reflexão', () => {
  test('inverte a componente normal e mantém a tangencial', () => {
    // Batendo na parede vertical: x inverte, y segue.
    const v = V.fromNumbers(3, 4)
    const normal = V.fromNumbers(1, 0)
    const r = V.reflect(v, normal)

    expect(perto(n(r.x), -3, 1e-2)).toBe(true)
    expect(perto(n(r.y), 4, 1e-2)).toBe(true)
  })

  test('preserva o comprimento — reflexão não tira nem põe energia', () => {
    const v = V.fromNumbers(2, -5)
    for (const normal of [V.fromNumbers(1, 0), V.fromNumbers(0, 1)]) {
      const r = V.reflect(v, normal)
      expect(perto(n(V.length(r)), n(V.length(v)), 1e-2)).toBe(true)
    }
  })

  test('refletir duas vezes volta ao original', () => {
    const v = V.fromNumbers(3, 4)
    const normal = V.fromNumbers(0, 1)
    const duasVezes = V.reflect(V.reflect(v, normal), normal)

    expect(perto(n(duasVezes.x), n(v.x), 1e-2)).toBe(true)
    expect(perto(n(duasVezes.y), n(v.y), 1e-2)).toBe(true)
  })
})

describe('determinismo', () => {
  test('sequência longa dá resultado idêntico', () => {
    const rodar = () => {
      const p = V.fromNumbers(0.5, 0.5)
      const v = V.fromNumbers(1.7, -0.9)
      for (let i = 0; i < 3_000; i++) {
        V.addScaledInto(p, v, F.from(0.008))
        if (p.x > F.from(2) || p.x < 0) v.x = -v.x
        if (p.y > F.from(1) || p.y < 0) v.y = -v.y
        V.scaleInto(v, v, F.from(0.9995))
      }
      return `${p.x},${p.y},${v.x},${v.y}`
    }
    expect(rodar()).toBe(rodar())
  })

  test('nenhuma componente sai da faixa segura numa simulação típica', () => {
    const p = V.fromNumbers(1, 0.5)
    const v = V.fromNumbers(12, -8) // tacada forte
    for (let i = 0; i < 5_000; i++) {
      V.addScaledInto(p, v, F.from(1 / 120))
      if (p.x > F.from(2.24) || p.x < 0) v.x = -v.x
      if (p.y > F.from(1.12) || p.y < 0) v.y = -v.y
      expect(() => V.check(p)).not.toThrow()
      expect(() => V.check(v)).not.toThrow()
    }
  })
})
