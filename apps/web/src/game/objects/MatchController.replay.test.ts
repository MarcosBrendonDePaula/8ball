import { MatchController } from '@/game/objects/MatchController'
import { hashState, jitterFromSeed, table as T } from '@zinc-pool/engine-physics'
import { GAME_MODES, type GameModeId } from '@zinc-pool/engine-rules'
import { decodeReplay, verifyReplay } from '@zinc-pool/replay'
import { describe, expect, test } from 'bun:test'

/**
 * O teste que sustenta a promessa de auditoria.
 *
 * Joga uma partida COMPLETA pelo controlador de verdade — o mesmo que o
 * navegador usa — e depois entrega os bytes gravados ao verificador, que
 * reconstrói tudo do zero. Se os dois discordarem em qualquer ponto, o replay
 * gravado na blockchain estaria provando o vencedor errado.
 *
 * É deliberadamente um teste caro e de ponta a ponta. Testar as peças isoladas
 * não pegaria a classe de bug que importa aqui, que é justamente jogo e
 * verificador fazerem coisas ligeiramente diferentes.
 */

/** Toca a simulação até a tacada terminar, com teto para não travar o teste. */
function aguardarTacada(match: MatchController): void {
  for (let i = 0; i < T.MAX_STEPS + 10; i++) {
    if (match.phase !== 'simulating') return
    match.fixedUpdate()
  }
  throw new Error('A tacada não terminou dentro do limite de passos.')
}

/**
 * Joga uma partida inteira com tacadas derivadas do índice.
 *
 * Nada de aleatório: o teste precisa produzir a mesma partida toda vez, senão
 * uma falha rara vira impossível de reproduzir.
 */
function jogarPartida(modo: GameModeId, semente: number, maxTacadas = 60): MatchController {
  const match = new MatchController(modo, semente)

  for (let i = 0; i < maxTacadas; i++) {
    if (match.summary.finished) break
    if (match.recorder.remaining <= 0) break

    // Escolha pendente é resolvida antes de jogar — as regras recusam tacada
    // com pendência aberta. Escolhe sempre a primeira opção, que é
    // determinística e é justamente o caminho que o replay tem de reproduzir.
    if (match.pending) match.choose(0)

    // Varre ângulos e forças de forma espalhada, para as tacadas de fato
    // acontecerem em vez de repetirem sempre a mesma geometria.
    const angulo = ((i * 2.399963 + semente * 0.7) % (Math.PI * 2))
    const forca = 0.35 + ((i * 7 + semente) % 13) / 20
    const efeito = { x: (((i * 5) % 7) - 3) / 6, y: (((i * 3) % 5) - 2) / 5 }

    match.shoot(angulo, forca, efeito)
    aguardarTacada(match)
  }

  return match
}

describe('replay reproduz a partida jogada', () => {
  for (const modo of GAME_MODES) {
    test(`${modo}: o verificador chega ao mesmo vencedor`, () => {
      const match = jogarPartida(modo, 7)

      expect(match.recorder.shotCount).toBeGreaterThan(0)

      // Passa pelos bytes de propósito: é essa a forma que vai on-chain, e
      // serializar/desserializar poderia perder algo que o objeto em memória
      // ainda tem.
      const bytes = match.recorder.toBytes()
      const resultado = verifyReplay(decodeReplay(bytes))

      expect(resultado.shotsApplied).toBe(match.recorder.shotCount)
      expect(resultado.winner).toBe(match.summary.winner)
    })

    test(`${modo}: a mesa final é idêntica, bola por bola`, () => {
      const match = jogarPartida(modo, 3)
      const resultado = verifyReplay(decodeReplay(match.recorder.toBytes()))

      // Mais forte que comparar o vencedor: um bug pode dar o mesmo vencedor
      // por acaso, mas não a mesma posição de 16 bolas em ponto fixo.
      expect(resultado.stateHash).toBe(hashDaMesa(match))
    })
  }
})

describe('quantização acontece na origem', () => {
  test('a física recebe o ângulo já encaixado na grade', () => {
    const match = new MatchController('eightball', 5)

    // Um ângulo que certamente não cai numa das 65.536 casas.
    const cru = 1.2345678901234
    match.shoot(cru, 0.5)

    const gravado = match.recorder.build().shots[0]!
    const dagrade = (gravado.angle / 65536) * Math.PI * 2

    expect(dagrade).not.toBe(cru)

    // O que importa: refazer a partida do replay dá exatamente a mesma mesa.
    // Se o jogo tivesse simulado o valor cru, isto falharia.
    aguardarTacada(match)
    const resultado = verifyReplay(decodeReplay(match.recorder.toBytes()))
    expect(resultado.stateHash).toBe(hashDaMesa(match))
  })

  test('o replay recusa mais tacadas do que cabe na transação', () => {
    const match = new MatchController('eightball', 1)
    // Enche o gravador sem simular, que é rápido. O limite é lido UMA vez:
    // `remaining` cai a cada tacada, e usá-lo na condição encerraria o laço na
    // metade.
    const cabem = match.recorder.remaining
    for (let i = 0; i < cabem; i++) {
      match.recorder.take(i * 0.01, 0.5)
    }

    expect(match.recorder.remaining).toBe(0)
    expect(() => match.recorder.take(0, 0.5)).toThrow(/não cabe na transação/)
  })
})

describe('o seed de 32 bytes atravessa a partida', () => {
  test('o replay guarda o mesmo seed que armou a mesa', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 3) % 256)
    const match = new MatchController('sinuca', seed)

    expect(match.recorder.build().seed).toEqual(seed)
  })

  test('seeds diferentes produzem quebras diferentes', () => {
    const a = new MatchController('eightball', semente(0x11))
    const b = new MatchController('eightball', semente(0x99))

    expect(hashDaMesa(a)).not.toBe(hashDaMesa(b))
  })

  /**
   * O jitter tem resolução grosseira, e isso é esperado.
   *
   * A amplitude de ±0,2 mm vale só 13 unidades em ponto fixo, então os 256
   * valores de um byte caem em 27 deslocamentos distintos — bytes vizinhos
   * produzem a MESMA posição. Não é falha: são 30 coordenadas independentes, o
   * que dá 27³⁰ arranjos, muito além do que alguém precomputaria para dominar
   * a quebra.
   *
   * Fica travado por teste porque mexer nisso mudaria a impressão digital da
   * física, que está ancorada on-chain — a correção exigiria uma versão nova.
   */
  test('a resolução do jitter é conhecida e estável', () => {
    const distintos = new Set(
      Array.from({ length: 256 }, (_, b) => jitterFromSeed(new Uint8Array(32).fill(b))[0]),
    )

    expect(distintos.size).toBe(27)
    expect(hashDaMesa(new MatchController('eightball', 1))).toBe(
      hashDaMesa(new MatchController('eightball', 2)),
    )
  })
})

/** Seed de 32 bytes variados a partir de uma semente, para os testes. */
const semente = (base: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (base * (i + 1) * 7 + i * 31) % 256)

/** Hash do estado físico, no mesmo formato que o verificador devolve. */
const hashDaMesa = (match: MatchController): string => hashState(match.table)
