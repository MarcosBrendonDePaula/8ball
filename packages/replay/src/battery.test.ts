import { describe, expect, test } from 'bun:test'
import golden from './battery.golden.json'
import { REPLAY_FIXTURES, buildReplayFixture, runReplayFixture } from './battery'
import { decodeReplay, encodeReplay } from './format'
import { verifyReplay } from './verify'

/**
 * A bateria de replays é a referência que os navegadores conferem.
 *
 * Aqui ela vale como regressão: se alguém mexer nas REGRAS sem querer, um
 * vencedor muda e o build quebra. Mexer de propósito exige regravar o golden, o
 * que força a decisão a aparecer no diff.
 */

const esperado = golden.fixtures as Record<string, string>

/*
 * UMA passada, reaproveitada por todos os testes.
 *
 * A bateria custa ~12 segundos. A primeira versão deste arquivo a rodava cinco
 * vezes — uma por asserção — e levava mais de oito minutos, o que na prática
 * significa um teste que ninguém roda.
 */
const resultados = new Map(
  REPLAY_FIXTURES.map((f) => [f.name, verifyReplay(buildReplayFixture(f))]),
)
const assinatura = (nome: string): string => {
  const r = resultados.get(nome)!
  return `${r.winner ?? '-'}:${r.shotsApplied}:${r.stateHash}`
}

describe('bateria de replays', () => {
  test('o golden cobre todas as fixtures', () => {
    expect(Object.keys(esperado)).toHaveLength(REPLAY_FIXTURES.length)
  })

  for (const f of REPLAY_FIXTURES) {
    test(`${f.name} reproduz o resultado gravado`, () => {
      expect(assinatura(f.name)).toBe(esperado[f.name]!)
    })
  }

  test('a assinatura pública bate com a interna', () => {
    // `runReplayFixture` é o que o navegador chama. Se ele divergisse do que
    // este arquivo mede, o teste passaria e o navegador reprovaria — ou pior,
    // o contrário.
    const f = REPLAY_FIXTURES[0]!
    expect(runReplayFixture(f)).toBe(assinatura(f.name))
  })
})

describe('a bateria mede o que promete', () => {
  test('as partidas andam, em vez de parar na primeira tacada', () => {
    /*
     * Esta é a checagem que faltava quando a bateria nasceu.
     *
     * Na primeira versão, quinze das dezesseis paravam na tacada 1: a primeira
     * falta abria bola na mão, o replay não tinha a posição gravada, e o
     * verificador parava. A bateria passava em toda plataforma porque não
     * chegava a exercitar as regras — concordância sobre nada.
     */
    for (const f of REPLAY_FIXTURES) {
      expect(resultados.get(f.name)!.shotsApplied).toBeGreaterThan(1)
    }
  })

  test('pelo menos algumas chegam a um vencedor decidido pelas regras', () => {
    const decididas = [...resultados.values()].filter((r) => r.winner !== null)
    // Com tacadas de sequência aritmética — pior que gente de verdade — a
    // sinuca não termina. O 8-Ball termina, e é o que garante que o caminho de
    // decisão de vencedor está coberto.
    expect(decididas.length).toBeGreaterThanOrEqual(4)
  })

  test('a fixture sobrevive à ida e volta pelos bytes', () => {
    // A bateria só prova algo se o que ela roda for o que vai gravado: se o
    // encode perdesse um campo, a verificação em memória concordaria com ela
    // mesma e divergiria do replay real. Uma fixture basta — o formato não
    // varia por partida, e cada uma custa segundos.
    const f = REPLAY_FIXTURES[0]!
    const voltou = decodeReplay(encodeReplay(buildReplayFixture(f)))
    expect(verifyReplay(voltou).stateHash).toBe(resultados.get(f.name)!.stateHash)
  })
})
