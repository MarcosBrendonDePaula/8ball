import { describe, expect, test } from 'bun:test'
import {
  Match,
  MatchRuleError,
  REVEAL_TIMEOUT_MS,
  SHOT_CLOCK_MS,
  commitOf,
  seedFromNonces,
} from '@/match'
import { DEFAULT_CUE, CUE_ARCHETYPES } from '@zinc-pool/engine-physics'
import { decodeReplay, encodeAngle, encodePower, verifyReplay } from '@zinc-pool/replay'

/**
 * O relógio é injetado, então nada aqui espera de verdade.
 *
 * Prazo de tacada, W.O. e abandono são as regras mais fáceis de implementar
 * com um `setTimeout` que ninguém consegue testar. Com o tempo como parâmetro,
 * avançar duas horas é uma linha — e um bug de contagem aparece na hora.
 */

const ALICE = 'Alice1111111111111111111111111111111111111'
const BOB = 'Bob22222222222222222222222222222222222222'

const nonceA = Uint8Array.from({ length: 32 }, (_, i) => i)
const nonceB = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)

const T0 = 1_000_000

function novaPartida(modo: 'eightball' | 'sinuca' = 'eightball'): Match {
  return new Match(
    modo,
    [
      { address: ALICE, cue: DEFAULT_CUE },
      { address: BOB, cue: CUE_ARCHETYPES.pesado },
    ],
    [commitOf(nonceA), commitOf(nonceB)],
    T0,
  )
}

/** Partida já com a quebra definida, pronta para a primeira tacada. */
function partidaIniciada(modo: 'eightball' | 'sinuca' = 'eightball'): Match {
  const m = novaPartida(modo)
  m.reveal(ALICE, nonceA, T0)
  m.reveal(BOB, nonceB, T0)
  return m
}

const tacada = (graus: number, forca: number) => ({
  angle: encodeAngle((graus * Math.PI) / 180),
  power: encodePower(forca),
  spinX: 0,
  spinY: 0,
})

const enderecoDaVez = (m: Match): string => m.players[m.turn!].address

describe('commit-reveal define a quebra', () => {
  test('a partida não começa antes dos dois revelarem', () => {
    const m = novaPartida()
    expect(m.phase).toBe('revealing')

    expect(m.reveal(ALICE, nonceA, T0)).toBe(false)
    expect(m.phase).toBe('revealing')
    expect(m.table).toBeNull()

    expect(m.reveal(BOB, nonceB, T0)).toBe(true)
    expect(m.phase).toBe('playing')
    expect(m.table).not.toBeNull()
  })

  test('nonce que não bate com o compromisso é recusado', () => {
    const m = novaPartida()
    const outro = Uint8Array.from({ length: 32 }, () => 7)

    // Sem esta checagem, o segundo a revelar escolheria o nonce depois de ver
    // o do adversário e controlaria a quebra sozinho.
    expect(() => m.reveal(ALICE, outro, T0)).toThrow(MatchRuleError)
    expect(m.phase).toBe('revealing')
  })

  test('ninguém revela duas vezes', () => {
    const m = novaPartida()
    m.reveal(ALICE, nonceA, T0)
    expect(() => m.reveal(ALICE, nonceA, T0)).toThrow(/já revelou/)
  })

  test('a ordem da concatenação importa e é fixa', () => {
    expect([...seedFromNonces(nonceA, nonceB)]).not.toEqual([...seedFromNonces(nonceB, nonceA)])
  })

  test('quem não revela a tempo anula a partida, sem vencedor', () => {
    const m = novaPartida()
    m.reveal(ALICE, nonceA, T0)

    const r = m.tick(T0 + REVEAL_TIMEOUT_MS)
    expect(r.changed).toBe(true)
    expect(m.phase).toBe('finished')

    // Sem vencedor: a partida não chegou a existir. O escrow volta pelos dois
    // pelo caminho de cancelamento on-chain.
    expect(m.result()?.winner).toBeNull()
    expect(m.result()?.reason).toBe('tempo')
  })
})

describe('vez e validação da tacada', () => {
  test('quem não é da vez não taca', () => {
    const m = partidaIniciada()
    const foraDaVez = m.players[m.turn === 0 ? 1 : 0].address

    expect(() => m.shoot(foraDaVez, tacada(180, 0.8), T0)).toThrow(/Não é a sua vez/)
  })

  test('carteira de fora é recusada', () => {
    const m = partidaIniciada()
    expect(() => m.shoot('Carol333', tacada(180, 0.8), T0)).toThrow(/não está nesta partida/)
  })

  test('recusa tacada fora das faixas do formato', () => {
    const m = partidaIniciada()
    const quem = enderecoDaVez(m)

    // O cliente é hostil por definição: qualquer coisa que chegue pela rede
    // pode ter sido escrita à mão.
    const invalidas = [
      { angle: 70_000, power: 100, spinX: 0, spinY: 0 },
      { angle: -1, power: 100, spinX: 0, spinY: 0 },
      { angle: 100, power: 900, spinX: 0, spinY: 0 },
      { angle: 100, power: 100, spinX: 200, spinY: 0 },
      { angle: 100, power: 100, spinX: 0, spinY: -200 },
      { angle: 1.5, power: 100, spinX: 0, spinY: 0 },
    ]

    for (const t of invalidas) {
      expect(() => m.shoot(quem, t, T0)).toThrow(MatchRuleError)
    }
    // Nenhuma delas entrou no replay.
    expect(m.recorder!.shotCount).toBe(0)
  })

  test('tacada válida avança a partida e entra no replay', () => {
    const m = partidaIniciada()
    const r = m.shoot(enderecoDaVez(m), tacada(180, 0.9), T0)

    expect(m.recorder!.shotCount).toBe(1)
    expect(r.stateHash).toHaveLength(8)
    expect(r.by).toBe(0)
  })

  test('não se taca durante uma decisão pendente', () => {
    const m = partidaIniciada()
    // Força uma pendência sintética para exercitar a guarda de fase.
    m.phase = 'deciding'
    expect(() => m.shoot(ALICE, tacada(0, 0.5), T0)).toThrow(/não está esperando uma tacada/)
  })
})

describe('prazo de tacada', () => {
  test('não dispara antes da hora', () => {
    const m = partidaIniciada()
    expect(m.tick(T0 + SHOT_CLOCK_MS - 1).changed).toBe(false)
  })

  test('estourar o prazo é falta, não passe de vez inventado', () => {
    const m = partidaIniciada()
    const antes = m.turn

    const r = m.tick(T0 + SHOT_CLOCK_MS)
    expect(r.timedOut).toBe(antes!)

    // A falta é registrada como tacada de força zero, então o replay a
    // reproduz sem nenhum caso especial.
    expect(m.recorder!.shotCount).toBe(1)
    expect(m.recorder!.build().shots[0]).toEqual({ angle: 0, power: 0, spinX: 0, spinY: 0 })
  })

  test('a falta por tempo passa a vez', () => {
    const m = partidaIniciada()
    const antes = m.turn

    m.tick(T0 + SHOT_CLOCK_MS)
    expect(m.turn).not.toBe(antes)
  })

  test('o relógio reinicia a cada tacada', () => {
    const m = partidaIniciada()
    m.shoot(enderecoDaVez(m), tacada(180, 0.9), T0 + 10_000)

    expect(m.deadline).toBe(T0 + 10_000 + SHOT_CLOCK_MS)
  })

  test('estourar o prazo NÃO termina a partida', () => {
    // A regra antiga declarava W.O. depois de três faltas. Ela protegia quem
    // ficava, mas punia quem teve uma queda de dois minutos — e entregava a
    // mesa sem ninguém ter encaçapado nada.
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 20 && m.phase !== 'finished'; i++) {
      agora += SHOT_CLOCK_MS
      m.tick(agora)
    }

    // Só termina se as REGRAS terminarem — e aí há um vencedor de verdade.
    if (m.phase === 'finished') {
      expect(m.result()?.reason).toBe('regras')
    }
  })
})

describe('desistência e desconexão', () => {
  test('quem desiste entrega a partida ao outro', () => {
    const m = partidaIniciada()
    m.forfeit(ALICE, T0)

    expect(m.phase).toBe('finished')
    expect(m.result()?.reason).toBe('desistência')
    expect(m.result()?.winner).toBe(1)
  })

  test('cair da conexão não perde a partida', () => {
    const m = partidaIniciada()
    m.markOffline(BOB, T0)

    // Antes isto virava derrota por abandono em 90 segundos.
    m.tick(T0 + 60 * 60 * 1000)
    expect(m.result()?.reason).not.toBe('abandono')
  })

  test('quem sumiu perde os turnos, não a partida', () => {
    const m = partidaIniciada()
    const ausente = m.turn!
    m.markOffline(m.players[ausente].address, T0)

    m.tick(T0 + SHOT_CLOCK_MS)

    // A vez passa para quem ficou, que joga e pode vencer pelas regras.
    expect(m.turn).not.toBe(ausente)
    expect(m.phase).not.toBe('finished')
  })

  test('com os dois fora, o relógio congela', () => {
    // Deixar correr faria a mesa acumular faltas sozinha e chegar a um
    // "vencedor" que nem estava lá.
    const m = partidaIniciada()
    m.markOffline(ALICE, T0)
    m.markOffline(BOB, T0)

    const antes = m.recorder!.shotCount
    m.tick(T0 + SHOT_CLOCK_MS * 10)

    expect(m.recorder!.shotCount).toBe(antes)
    expect(m.phase).not.toBe('finished')
  })

  test('quem volta encontra a partida onde parou e destrava o relógio', () => {
    const m = partidaIniciada()
    m.markOffline(ALICE, T0)
    m.markOffline(BOB, T0)
    m.tick(T0 + SHOT_CLOCK_MS * 5)

    m.markOnline(BOB)
    const antes = m.recorder!.shotCount
    m.tick(T0 + SHOT_CLOCK_MS * 6)

    expect(m.recorder!.shotCount).toBeGreaterThan(antes)
  })

  test('quem ficou consegue jogar e vencer pelas regras', () => {
    const m = partidaIniciada()
    let agora = T0

    // O adversário some; o presente joga sempre que é a vez dele.
    const presente = m.players[0].address
    m.markOffline(m.players[1].address, agora)

    for (let i = 0; i < 40 && m.phase !== 'finished'; i++) {
      agora += 1_000
      if (m.turn === 0 && m.phase === 'playing') {
        if (m.ballInHand) m.place(presente, 0.5, 0.5, agora)
        if (m.ballInHand === null) m.shoot(presente, tacada((i * 47) % 360, 0.85), agora)
      } else {
        agora += SHOT_CLOCK_MS
        m.tick(agora)
      }
    }

    // Não importa quem venceu: importa que NÃO terminou por abandono. Ou as
    // regras decidiram, ou o replay lotou — nunca um relógio entregando a mesa.
    if (m.phase === 'finished') {
      expect(['regras', 'replay cheio']).toContain(m.result()!.reason)
    }
  })
})

describe('o replay da partida em rede é verificável', () => {
  test('uma partida jogada pelo servidor reproduz o mesmo vencedor', () => {
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 40; i++) {
      if (m.phase !== 'playing') break
      agora += 1_000
      m.shoot(enderecoDaVez(m), tacada((i * 47) % 360, 0.5 + ((i * 7) % 40) / 100), agora)
    }

    const bytes = m.recorder!.toBytes()
    const conferido = verifyReplay(decodeReplay(bytes))

    // O verificador parte só dos bytes e chega ao mesmo lugar que o servidor.
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
    expect(conferido.winner).toBe(m.summary!.winner)
  })

  test('a falta por tempo também é reproduzível', () => {
    const m = partidaIniciada()
    let agora = T0

    m.shoot(enderecoDaVez(m), tacada(180, 0.9), agora)
    agora += SHOT_CLOCK_MS
    m.tick(agora)

    // A falta abre bola na mão; colocar a branca é obrigatório antes de jogar.
    if (m.ballInHand !== null) {
      m.place(m.players[m.summary!.turn].address, 0.5, 0.5, agora)
    }
    if (m.phase === 'playing' && m.ballInHand === null) {
      m.shoot(enderecoDaVez(m), tacada(90, 0.6), agora)
    }

    const conferido = verifyReplay(decodeReplay(m.recorder!.toBytes()))
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
  })

  test('o taco de cada jogador vai gravado', () => {
    const m = partidaIniciada()
    const r = m.recorder!.build()

    expect(r.cues[0]).toEqual(DEFAULT_CUE)
    expect(r.cues[1]).toEqual(CUE_ARCHETYPES.pesado)
  })
})

describe('bola na mão', () => {
  /** Leva a partida até uma falta, para abrir a bola na mão. */
  function comFalta(): { m: Match; agora: number } {
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 12 && m.ballInHand === null && m.phase === 'playing'; i++) {
      agora += 1_000
      m.shoot(enderecoDaVez(m), tacada((i * 61) % 360, 0.9), agora)
    }
    return { m, agora }
  }

  test('não se taca com a branca encaçapada', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    // A física recusaria de qualquer forma, mas com uma mensagem sobre estado
    // interno. Esta diz o que o jogador precisa fazer.
    expect(() => m.shoot(enderecoDaVez(m), tacada(0, 0.5), agora)).toThrow(/Coloque a branca/)
  })

  test('a posição é gravada no replay', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const antes = m.recorder!.placementCount
    m.place(m.players[m.summary!.turn].address, 1.2, 0.4, agora)

    expect(m.recorder!.placementCount).toBe(antes + 1)
    expect(m.ballInHand).toBeNull()
  })

  test('a bola na mão é de quem tem a vez', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const outro = m.players[m.summary!.turn === 0 ? 1 : 0].address
    expect(() => m.place(outro, 1, 0.5, agora)).toThrow(/não é sua/)
  })

  test('quem não coloca a tempo fica com o ponto de saque', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    const antes = m.recorder!.placementCount
    m.tick(agora + SHOT_CLOCK_MS)

    // A posição neutra também vai gravada: o verificador precisa dela como
    // precisa de qualquer outra.
    expect(m.recorder!.placementCount).toBe(antes + 1)
  })

  test('a partida com bola na mão continua verificável', () => {
    const { m, agora } = comFalta()
    if (m.ballInHand === null) return

    m.place(m.players[m.summary!.turn].address, 0.6, 0.7, agora)
    if (m.phase === 'playing' && m.ballInHand === null) {
      m.shoot(enderecoDaVez(m), tacada(10, 0.7), agora + 1000)
    }

    const conferido = verifyReplay(decodeReplay(m.recorder!.toBytes()))
    expect(conferido.shotsApplied).toBe(m.recorder!.shotCount)
    expect(conferido.stoppedBecause).toBeNull()
  })
})

describe('limite gravável', () => {
  test('sem espaço no replay, a partida é anulada em vez de decidida', () => {
    // O replay é a prova. Declarar um vencedor que ele não sustenta quebraria
    // a única coisa que o sistema promete — então as entradas voltam.
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 200 && m.phase !== 'finished'; i++) {
      agora += SHOT_CLOCK_MS
      m.tick(agora)
    }

    if (m.result()?.reason === 'replay cheio') {
      expect(m.result()?.winner).toBeNull()
      // Os bytes ainda cabem: nunca foi gravado além do limite.
      expect(() => m.recorder!.toBytes()).not.toThrow()
    }
  })
})

describe('caçapa declarada', () => {
  /**
   * O bug que isto fecha era grave e silencioso: com a regra padrão
   * (`eight-only`), encaçapar a bola 8 sem declarar dá falta `no-call` — e
   * falta na 8 é DERROTA. Sem uma forma de declarar, ninguém conseguia vencer
   * legitimamente; só se o adversário afundasse a 8 por engano.
   */
  function naBolaOito(): { m: Match; agora: number } | null {
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 60 && m.phase === 'playing'; i++) {
      agora += 1_000
      if (m.callRequired) return { m, agora }
      if (m.ballInHand) m.place(m.players[m.summary!.turn].address, 0.5, 0.5, agora)
      if (m.ballInHand === null) m.shoot(enderecoDaVez(m), tacada((i * 41) % 360, 0.85), agora)
    }
    return null
  }

  test('sem declarar, a tacada é recusada antes de acontecer', () => {
    const achou = naBolaOito()
    if (!achou) return

    expect(() => achou.m.shoot(enderecoDaVez(achou.m), tacada(0, 0.8), achou.agora)).toThrow(
      /Declare a caçapa/,
    )
  })

  test('declarando, a tacada é aceita', () => {
    const achou = naBolaOito()
    if (!achou) return

    const antes = achou.m.recorder!.shotCount
    achou.m.shoot(enderecoDaVez(achou.m), tacada(0, 0.8), achou.agora, { ball: 8, pocket: 2 })

    expect(achou.m.recorder!.shotCount).toBe(antes + 1)
    expect(achou.m.recorder!.callCount).toBeGreaterThan(0)
  })

  test('a partida com declaração continua verificável', () => {
    const achou = naBolaOito()
    if (!achou) return

    achou.m.shoot(enderecoDaVez(achou.m), tacada(30, 0.8), achou.agora, { ball: 8, pocket: 1 })

    const conferido = verifyReplay(decodeReplay(achou.m.recorder!.toBytes()))
    expect(conferido.stoppedBecause).toBeNull()
    expect(conferido.shotsApplied).toBe(achou.m.recorder!.shotCount)
  })

  test('o relógio declara por quem não declarou, para as listas não desalinharem', () => {
    const achou = naBolaOito()
    if (!achou) return

    const antes = achou.m.recorder!.callCount
    achou.m.tick(achou.agora + SHOT_CLOCK_MS)

    // A tacada nula não encaçapa nada, então a declaração não muda o
    // julgamento — ela existe para o verificador consumir uma por tacada
    // exigida, como o jogo grava.
    expect(achou.m.recorder!.callCount).toBe(antes + 1)

    const conferido = verifyReplay(decodeReplay(achou.m.recorder!.toBytes()))
    expect(conferido.stoppedBecause).toBeNull()
  })
})

describe('a cozinha é regra, não sugestão de interface', () => {
  /**
   * A restrição vivia SÓ no navegador. Um cliente modificado largava a branca
   * colada no rack depois de errar a quebra, o servidor aceitava, e o
   * verificador — que reproduz entradas sem julgar se elas eram legais —
   * certificava a partida como válida para sempre.
   */
  function comFaltaNaQuebra(): { m: Match; agora: number } | null {
    for (let semente = 0; semente < 40; semente++) {
      const m = partidaIniciada()
      // Quebra fraca: a branca cai ou nada vai à tabela.
      m.shoot(enderecoDaVez(m), tacada(semente * 9, 0.05), T0)
      if (m.ballInHand === 'kitchen') return { m, agora: T0 }
    }
    return null
  }

  test('posição além da linha da cabeça é recusada', () => {
    const achou = comFaltaNaQuebra()
    if (!achou) return

    const quem = achou.m.players[achou.m.summary!.turn].address
    // 1.9m está do outro lado da mesa; a cozinha vai até 0.495m.
    expect(() => achou.m.place(quem, 1.9, 0.5, achou.agora)).toThrow(/linha da cabeça/)
  })

  test('posição dentro da cozinha é aceita', () => {
    const achou = comFaltaNaQuebra()
    if (!achou) return

    const quem = achou.m.players[achou.m.summary!.turn].address
    expect(() => achou.m.place(quem, 0.3, 0.5, achou.agora)).not.toThrow()
  })

  test('fora da quebra, a mesa inteira vale', () => {
    // `anywhere` não pode herdar a restrição: a WPA só a impõe após falta na
    // quebra.
    const m = partidaIniciada()
    let agora = T0

    for (let i = 0; i < 12 && m.ballInHand !== 'anywhere'; i++) {
      if (m.phase !== 'playing' || m.ballInHand !== null) break
      agora += 1_000
      m.shoot(enderecoDaVez(m), tacada((i * 47) % 360, 0.9), agora)
    }
    if (m.ballInHand !== 'anywhere') return

    const quem = m.players[m.summary!.turn].address
    expect(() => m.place(quem, 1.9, 0.5, agora)).not.toThrow()
  })
})
