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
   * A entropia da quebra mora no deslize do rack, não no jitter por bola.
   *
   * A v1 dava ±0,2 mm a cada bola, o que tinha dois defeitos ao mesmo tempo:
   * a resolução do ponto fixo reduzia os 256 valores do byte a 27 posições, e
   * a soma na diagonal excedia a folga do triângulo, fazendo as bolas
   * nascerem sobrepostas.
   *
   * A v2 desloca o TRIÂNGULO INTEIRO em ±2 mm — que cobre os 256 valores do
   * byte — e mantém o jitter por bola pequeno o bastante para o rack não
   * abrir. Como todas as bolas andam junto, a distância entre elas não muda.
   */
  test('o deslize do rack usa a entropia inteira do byte', () => {
    const posicoes = new Set(
      Array.from({ length: 256 }, (_, byte) => {
        const seed = new Uint8Array(32)
        seed[30] = byte
        return jitterFromSeed(seed)[0]
      }),
    )

    expect(posicoes.size).toBe(256)
  })

  test('seeds que diferem num único byte produzem mesas diferentes', () => {
    // O que a v1 não conseguia: bytes vizinhos caíam na mesma posição.
    const a = new Uint8Array(32)
    const b = new Uint8Array(32)
    b[30] = 1

    expect(hashDaMesa(new MatchController('eightball', a))).not.toBe(
      hashDaMesa(new MatchController('eightball', b)),
    )
  })
})

/** Seed de 32 bytes variados a partir de uma semente, para os testes. */
const semente = (base: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (base * (i + 1) * 7 + i * 31) % 256)

/** Hash do estado físico, no mesmo formato que o verificador devolve. */
const hashDaMesa = (match: MatchController): string => hashState(match.table)

describe('reconstruir do histórico chega ao mesmo lugar', () => {
  /**
   * O teste que sustenta a reconexão.
   *
   * Quem chega no meio de uma partida recebe o histórico e o aplica; se a mesa
   * reconstruída não for IDÊNTICA à de quem jogou ao vivo, o jogador voltaria
   * olhando para outra partida — e a próxima tacada dele seria mirada numa
   * mesa que não existe.
   */
  for (const modo of GAME_MODES) {
    test(`${modo}: mesa reconstruída é idêntica, bola por bola`, () => {
      const aoVivo = jogarPartida(modo, 11, 25)

      const r = aoVivo.recorder.build()
      const reconstruida = new MatchController(modo, r.seed)
      reconstruida.catchUp(r.shots, r.decisions)

      expect(hashDaMesa(reconstruida)).toBe(hashDaMesa(aoVivo))
    })

    test(`${modo}: o estado de regras também confere`, () => {
      const aoVivo = jogarPartida(modo, 5, 25)

      const r = aoVivo.recorder.build()
      const reconstruida = new MatchController(modo, r.seed)
      reconstruida.catchUp(r.shots, r.decisions)

      // Não basta a mesa: de quem é a vez e quem já venceu vêm das regras.
      expect(reconstruida.summary.turn).toBe(aoVivo.summary.turn)
      expect(reconstruida.summary.winner).toBe(aoVivo.summary.winner)
      expect(reconstruida.summary.onTable).toEqual(aoVivo.summary.onTable)
    })
  }

  test('o replay da reconstruída ainda verifica', () => {
    // Reconstruir não pode corromper o gravador: o replay que sai dela precisa
    // continuar provando a mesma partida.
    const aoVivo = jogarPartida('eightball', 9, 25)
    const r = aoVivo.recorder.build()

    const reconstruida = new MatchController('eightball', r.seed)
    reconstruida.catchUp(r.shots, r.decisions)

    const conferido = verifyReplay(decodeReplay(reconstruida.recorder.toBytes()))
    expect(conferido.stateHash).toBe(hashDaMesa(aoVivo))
  })

  test('histórico vazio deixa a mesa na quebra', () => {
    const m = new MatchController('eightball', 4)
    const antes = hashDaMesa(m)

    m.catchUp([], [])

    expect(hashDaMesa(m)).toBe(antes)
  })
})
