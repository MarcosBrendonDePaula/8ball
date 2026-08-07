import { describe, expect, test } from 'bun:test'
import golden from './fixtures.golden.json'
import { FIXTURES, fixturesDigest, runAllFixtures, runFixture } from './fixtures'
import { ENGINE_VERSION, PHYSICS_DIGEST } from './table'

/**
 * Guarda de regressão da física.
 *
 * Se um hash mudar aqui, a física mudou. Isso não é necessariamente errado —
 * mas precisa ser uma decisão consciente, e regravar o golden faz a mudança
 * aparecer no diff em vez de passar despercebida.
 *
 * O mesmo arquivo é a referência que o navegador compara: enquanto Bun e
 * Chrome produzirem este digest, a premissa de determinismo do TDD §4 está de
 * pé. Sem ela, o cliente não pode prever a tacada localmente e o replay
 * público não prova nada.
 */

describe('versão da física', () => {
  test('o digest declarado bate com a física atual', () => {
    // Este teste é o que força a versão a ser incrementada de propósito.
    // Mudou a física sem mexer aqui? O build quebra, e é para quebrar mesmo:
    // um replay gravado com a física antiga passaria a dar outro vencedor.
    expect(fixturesDigest()).toBe(PHYSICS_DIGEST)
  })

  test('a versão é um inteiro positivo', () => {
    expect(Number.isInteger(ENGINE_VERSION)).toBe(true)
    expect(ENGINE_VERSION).toBeGreaterThan(0)
  })

  test('o golden e o digest declarado concordam', () => {
    expect(golden.digest).toBe(PHYSICS_DIGEST)
  })
})

describe('bateria de referência', () => {
  test('a bateria não encolheu sem querer', () => {
    expect(FIXTURES.length).toBe(24)
    expect(Object.keys(golden.fixtures)).toHaveLength(FIXTURES.length)
  })

  test('cada partida bate com o hash gravado', () => {
    for (const fixture of FIXTURES) {
      const esperado = (golden.fixtures as Record<string, string>)[fixture.name]
      expect(esperado).toBeDefined()
      expect(runFixture(fixture)).toBe(esperado!)
    }
  })

  test('o digest da bateria inteira bate', () => {
    expect(fixturesDigest()).toBe(golden.digest)
  })

  test('rodar duas vezes na mesma máquina dá o mesmo resultado', () => {
    expect(runAllFixtures()).toEqual(runAllFixtures())
  })

  test('as partidas são distintas entre si — a bateria cobre casos diferentes', () => {
    const resultados = Object.values(runAllFixtures())
    expect(new Set(resultados).size).toBe(resultados.length)
  })

  test('a ordem de execução não afeta o resultado de cada partida', () => {
    // Nenhum estado global vaza de uma simulação para a próxima.
    const direta = FIXTURES.map(runFixture)
    const invertida = [...FIXTURES].reverse().map(runFixture).reverse()
    expect(direta).toEqual(invertida)
  })
})
