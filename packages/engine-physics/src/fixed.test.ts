import { describe, expect, test } from 'bun:test'
import * as F from './fixed'

/**
 * A engine inteira se apoia neste módulo. Um erro aqui não aparece como bug
 * óbvio — aparece como duas máquinas discordando sobre quem ganhou a partida.
 * Por isso os testes cobrem exatidão, sinal, arredondamento e a invariante de
 * faixa, não só "a conta dá mais ou menos certo".
 */

const perto = (a: number, b: number, tolerancia = 1e-4) => Math.abs(a - b) < tolerancia

describe('conversão', () => {
  test('ida e volta preserva o valor dentro da resolução', () => {
    for (const v of [0, 1, -1, 0.5, -0.5, 2.25, 100, -100, 0.0001, 255.9]) {
      expect(perto(F.toNumber(F.from(v)), v, 1 / 65536)).toBe(true)
    }
  })

  test('fromInt não passa por float', () => {
    expect(F.fromInt(3)).toBe(3 * F.ONE)
    expect(F.fromInt(-7)).toBe(-7 * F.ONE)
  })

  test('todo Fixed é inteiro exato', () => {
    for (const v of [0.1, 1 / 3, Math.PI, -Math.E]) {
      expect(Number.isInteger(F.from(v))).toBe(true)
    }
  })
})

describe('invariante de faixa', () => {
  test('aceita valores dentro da faixa segura', () => {
    expect(() => F.check(F.from(255))).not.toThrow()
    expect(() => F.check(F.from(-255))).not.toThrow()
  })

  test('recusa valores que quebram a exatidão dos produtos', () => {
    expect(() => F.check(F.MAX_SAFE_FIXED)).toThrow(F.FixedOverflowError)
    expect(() => F.check(-F.MAX_SAFE_FIXED)).toThrow(F.FixedOverflowError)
  })

  test('recusa não-inteiro — sinal de que um float vazou para dentro', () => {
    expect(() => F.check(1.5)).toThrow(F.FixedOverflowError)
  })

  test('produto de dois valores no limite continua exato', () => {
    // É esta a razão de existir a invariante: 2^23 * 2^23 = 2^46 < 2^53.
    const limite = F.MAX_SAFE_FIXED / 2
    const produto = limite * limite
    expect(Number.isSafeInteger(produto)).toBe(true)
  })
})

describe('aritmética', () => {
  test('soma e subtração são exatas', () => {
    expect(F.add(F.from(1.5), F.from(2.25))).toBe(F.from(3.75))
    expect(F.sub(F.from(1.5), F.from(2.25))).toBe(F.from(-0.75))
  })

  test('multiplicação bate com a referência em float', () => {
    const casos: Array<[number, number]> = [
      [2, 3],
      [0.5, 0.5],
      [-1.5, 4],
      [-2, -3],
      [0.1, 0.1],
      [100, 2.5],
    ]
    for (const [a, b] of casos) {
      expect(perto(F.toNumber(F.mul(F.from(a), F.from(b))), a * b, 1e-3)).toBe(true)
    }
  })

  test('multiplicar por zero e por um', () => {
    const x = F.from(3.75)
    expect(F.mul(x, F.ZERO)).toBe(0)
    expect(F.mul(x, F.ONE)).toBe(x)
  })

  test('multiplicação é comutativa — senão a ordem das colisões importaria', () => {
    for (const [a, b] of [[1.7, -3.2], [0.001, 250], [-9.5, -0.25]] as const) {
      expect(F.mul(F.from(a), F.from(b))).toBe(F.mul(F.from(b), F.from(a)))
    }
  })

  test('arredondamento é uniforme (floor), não em direção a zero', () => {
    // Truncar daria +0 e -0 aqui; floor dá -1, que é o mesmo passo para os
    // dois sinais. Viés de sinal se acumula ao longo da simulação.
    const minusculo = 1
    expect(F.mul(minusculo, minusculo)).toBe(0)
    expect(F.mul(-minusculo, minusculo)).toBe(-1)
  })

  test('divisão bate com a referência', () => {
    for (const [a, b] of [[6, 3], [1, 3], [-9, 2], [0.5, 0.25]] as const) {
      expect(perto(F.toNumber(F.div(F.from(a), F.from(b))), a / b, 1e-3)).toBe(true)
    }
  })

  test('divisão por zero é erro, não infinito silencioso', () => {
    expect(() => F.div(F.ONE, F.ZERO)).toThrow()
  })

  test('sqr é igual a mul consigo mesmo', () => {
    for (const v of [0, 1.5, -2.25, 10, 0.001]) {
      expect(F.sqr(F.from(v))).toBe(F.mul(F.from(v), F.from(v)))
    }
  })

  test('clamp, min, max e abs', () => {
    expect(F.clamp(F.from(5), F.from(0), F.from(3))).toBe(F.from(3))
    expect(F.clamp(F.from(-5), F.from(0), F.from(3))).toBe(F.from(0))
    expect(F.clamp(F.from(2), F.from(0), F.from(3))).toBe(F.from(2))
    expect(F.min(F.from(1), F.from(2))).toBe(F.from(1))
    expect(F.max(F.from(1), F.from(2))).toBe(F.from(2))
    expect(F.abs(F.from(-3.5))).toBe(F.from(3.5))
  })
})

describe('raiz quadrada', () => {
  test('valores exatos', () => {
    expect(F.sqrt(F.from(4))).toBe(F.from(2))
    expect(F.sqrt(F.from(9))).toBe(F.from(3))
    expect(F.sqrt(F.from(1))).toBe(F.from(1))
    expect(F.sqrt(F.ZERO)).toBe(0)
  })

  test('valores irracionais dentro da resolução', () => {
    for (const v of [2, 3, 5, 10, 0.25, 0.5, 100, 200]) {
      expect(perto(F.toNumber(F.sqrt(F.from(v))), Math.sqrt(v), 1e-3)).toBe(true)
    }
  })

  test('raiz de negativo é erro', () => {
    expect(() => F.sqrt(F.from(-1))).toThrow()
  })

  test('é monotônica — base para comparar distâncias sem inverter ordem', () => {
    let anterior = -1
    for (let v = 0; v <= 200; v += 0.37) {
      const atual = F.sqrt(F.from(v))
      expect(atual).toBeGreaterThanOrEqual(anterior)
      anterior = atual
    }
  })

  test('termina para valores minúsculos', () => {
    expect(F.sqrt(1)).toBeGreaterThanOrEqual(0)
    expect(F.sqrt(2)).toBeGreaterThanOrEqual(0)
  })

  test('hypot bate com a referência', () => {
    for (const [x, y] of [[3, 4], [1, 1], [-5, 12], [0, 7]] as const) {
      expect(perto(F.toNumber(F.hypot(F.from(x), F.from(y))), Math.hypot(x, y), 1e-3)).toBe(true)
    }
  })
})

describe('trigonometria', () => {
  test('valores conhecidos', () => {
    expect(perto(F.toNumber(F.sin(F.ZERO)), 0, 1e-2)).toBe(true)
    expect(perto(F.toNumber(F.sin(F.from(Math.PI / 2))), 1, 1e-2)).toBe(true)
    expect(perto(F.toNumber(F.sin(F.PI)), 0, 1e-2)).toBe(true)
    expect(perto(F.toNumber(F.cos(F.ZERO)), 1, 1e-2)).toBe(true)
    expect(perto(F.toNumber(F.cos(F.from(Math.PI / 2))), 0, 1e-2)).toBe(true)
  })

  test('acompanha a referência em toda a volta', () => {
    for (let grau = 0; grau < 360; grau += 3) {
      const rad = (grau * Math.PI) / 180
      expect(perto(F.toNumber(F.sin(F.from(rad))), Math.sin(rad), 5e-3)).toBe(true)
      expect(perto(F.toNumber(F.cos(F.from(rad))), Math.cos(rad), 5e-3)).toBe(true)
    }
  })

  test('identidade sin² + cos² = 1', () => {
    for (let grau = 0; grau < 360; grau += 7) {
      const a = F.from((grau * Math.PI) / 180)
      const soma = F.sqr(F.sin(a)) + F.sqr(F.cos(a))
      expect(perto(F.toNumber(soma), 1, 1e-2)).toBe(true)
    }
  })

  test('ângulo negativo e acima de uma volta dão o mesmo que o normalizado', () => {
    const base = F.from(1.2)
    expect(F.sin(base)).toBe(F.sin(base + F.TAU))
    expect(F.sin(base)).toBe(F.sin(base - F.TAU))
    expect(F.cos(base)).toBe(F.cos(base + F.TAU * 3))
  })

  test('normalizeAngle mantém o ângulo na faixa segura', () => {
    for (const a of [F.from(-100), F.from(1000), F.TAU * 5, -F.TAU * 3]) {
      const n = F.normalizeAngle(a)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(F.TAU)
      expect(() => F.check(n)).not.toThrow()
    }
  })
})

describe('determinismo', () => {
  test('a mesma sequência de operações dá exatamente o mesmo resultado', () => {
    const rodar = () => {
      let acc = F.from(1.234)
      for (let i = 0; i < 5_000; i++) {
        acc = F.mul(acc, F.from(1.0001))
        acc = F.add(acc, F.sin(F.from(i / 100)))
        acc = F.sub(acc, F.div(acc, F.from(3)))
        if (acc > F.from(200) || acc < F.from(-200)) acc = F.from(1.234)
      }
      return acc
    }
    expect(rodar()).toBe(rodar())
  })

  test('nenhuma operação produz NaN, Infinity ou fracionário', () => {
    let acc = F.from(0.5)
    for (let i = 1; i < 2_000; i++) {
      acc = F.mul(acc, F.from(1.01))
      acc = F.add(acc, F.cos(F.from(i)))
      acc = F.div(acc, F.from(1.003))
      acc = F.normalizeAngle(acc)

      expect(Number.isFinite(acc)).toBe(true)
      expect(Number.isInteger(acc)).toBe(true)
      expect(Math.abs(acc)).toBeLessThan(F.MAX_SAFE_FIXED)
    }
  })

  test('a tabela de seno é idêntica a cada consulta', () => {
    const primeira = Array.from({ length: 256 }, (_, i) => F.sin(F.from((i * Math.PI) / 128)))
    const segunda = Array.from({ length: 256 }, (_, i) => F.sin(F.from((i * Math.PI) / 128)))
    expect(primeira).toEqual(segunda)
  })
})
