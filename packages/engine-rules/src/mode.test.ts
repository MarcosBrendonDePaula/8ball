import { describe, expect, test } from 'bun:test'
import { GAME_MODES, GAME_MODE_INFO, getGameMode, isGameModeId } from './mode'
import type { MatchState, ShotOutcome } from './eightball/types'
import type { SinucaOutcome, SinucaState } from './sinuca/types'

/**
 * Testes do registro de modalidades.
 *
 * O que garantem: acrescentar uma modalidade nova não exige mexer no servidor
 * nem na interface. Se um destes falhar, a indireção parou de valer a pena e
 * alguém vai acabar espalhando `if (modo === 'sinuca')` pelo projeto.
 */

describe('registro', () => {
  test('toda modalidade declarada está registrada', () => {
    for (const id of GAME_MODES) {
      expect(() => getGameMode(id)).not.toThrow()
      expect(GAME_MODE_INFO[id]).toBeDefined()
    }
  })

  test('modalidade desconhecida é erro, não padrão silencioso', () => {
    // Cair para um padrão faria os dois jogadores jogarem jogos diferentes.
    expect(() => getGameMode('roleta' as never)).toThrow()
  })

  test('isGameModeId valida entrada externa', () => {
    expect(isGameModeId('eightball')).toBe(true)
    expect(isGameModeId('sinuca')).toBe(true)
    expect(isGameModeId('snooker')).toBe(false)
    expect(isGameModeId('')).toBe(false)
  })

  test('cada modalidade tem nome e descrição para a interface', () => {
    for (const id of GAME_MODES) {
      const info = GAME_MODE_INFO[id]
      expect(info.name.length).toBeGreaterThan(0)
      expect(info.description.length).toBeGreaterThan(10)
      expect(info.ballCount).toBeGreaterThan(0)
    }
  })
})

describe('contrato comum', () => {
  test('toda modalidade cria partida com o quebrador certo', () => {
    for (const id of GAME_MODES) {
      const modo = getGameMode(id)
      const estado = modo.create(1)
      expect(modo.summarize(estado).turn).toBe(1)
      expect(modo.winnerOf(estado)).toBeNull()
    }
  })

  test('toda modalidade resume a partida sem expor o formato interno', () => {
    for (const id of GAME_MODES) {
      const modo = getGameMode(id)
      const resumo = modo.summarize(modo.create(0))

      expect(resumo.finished).toBe(false)
      expect(resumo.onTable.length).toBeGreaterThan(0)
      expect(typeof resumo.status).toBe('string')
    }
  })

  test('toda modalidade responde se impõe uma bola alvo', () => {
    // A interface pergunta isto para destacar a bola na mesa. Uma modalidade
    // que não respondesse obrigaria a tela a ramificar por id de jogo.
    for (const id of GAME_MODES) {
      const modo = getGameMode(id)
      const alvo = modo.targetBallOf(modo.create(0))

      expect(alvo === null || typeof alvo === 'number').toBe(true)
    }
  })

  test('toda modalidade aceita desistência', () => {
    for (const id of GAME_MODES) {
      const modo = getGameMode(id)
      const depois = modo.forfeit(modo.create(0), 0)

      expect(modo.winnerOf(depois)).toBe(1)
      expect(modo.summarize(depois).finished).toBe(true)
    }
  })
})

describe('8-Ball pelo registro', () => {
  const modo = getGameMode('eightball')

  test('resume o estágio da partida', () => {
    const inicial = modo.create(0) as unknown as MatchState
    expect(modo.summarize(inicial as never).status).toBe('Quebra')
    expect(modo.summarize(inicial as never).score).toBeNull()
  })

  test('16 bolas na mesa no início, sem contar a branca', () => {
    // 15 numeradas: as sete lisas, a 8 e as sete listradas.
    expect(modo.summarize(modo.create(0)).onTable).toHaveLength(15)
  })

  test('não impõe bola alvo: o alvo é o grupo inteiro', () => {
    // Apontar uma bola do grupo faria a interface anunciar uma obrigação que a
    // regra não impõe.
    expect(modo.targetBallOf(modo.create(0))).toBeNull()
  })

  test('julga uma tacada pelo contrato comum', () => {
    const estado = modo.create(0)
    const saida = {
      firstContact: 1,
      pocketed: [1],
      offTable: [],
      ballsToRail: 4,
      railAfterContact: true,
      eightBallPocket: null,
      called: null,
    } as unknown as ShotOutcome

    const { state } = modo.play(estado, saida as never)
    expect(modo.summarize(state).onTable).toHaveLength(14)
  })
})

describe('sinuca pelo registro', () => {
  const modo = getGameMode('sinuca')

  test('resume mostrando a bola da vez e o placar', () => {
    const resumo = modo.summarize(modo.create(0))

    expect(resumo.status).toContain('vermelha')
    expect(resumo.score).toEqual([0, 0])
  })

  test('a bola alvo é a menor ainda na mesa', () => {
    // A ordem crescente é a regra central do jogo, e é o que a mesa destaca.
    expect(modo.targetBallOf(modo.create(0))).toBe(1)
  })

  test('7 bolas na mesa no início', () => {
    expect(modo.summarize(modo.create(0)).onTable).toHaveLength(7)
  })

  test('julga uma tacada pelo contrato comum', () => {
    const saida = {
      firstContact: 1,
      pocketed: [1],
      offTable: [],
      railAfterContact: true,
      nominated: null,
    } as unknown as SinucaOutcome

    const { state } = modo.play(modo.create(0), saida as never)
    const resumo = modo.summarize(state)

    expect(resumo.score).toEqual([1, 0])
    expect(resumo.onTable).toHaveLength(6)
  })
})

describe('as duas modalidades são independentes', () => {
  test('jogar uma não afeta a outra', () => {
    const oito = getGameMode('eightball')
    const sinuca = getGameMode('sinuca')

    const estadoSinuca = sinuca.create(0) as unknown as SinucaState
    oito.forfeit(oito.create(0), 0)

    expect(sinuca.summarize(estadoSinuca as never).finished).toBe(false)
  })

  test('cada uma tem o próprio número de bolas', () => {
    expect(GAME_MODE_INFO.eightball.ballCount).not.toBe(GAME_MODE_INFO.sinuca.ballCount)
  })
})

describe('achados da auditoria de regras', () => {
  test('"recolocar a 8" pede a bola de volta à mesa física', () => {
    // Antes, a 8 saía da lista de encaçapadas nas REGRAS mas ninguém a
    // devolvia à mesa. Quem limpasse o grupo nunca mais conseguia tocá-la:
    // toda tacada virava falta por falta de contato, para sempre.
    const modo = getGameMode('eightball')

    const inicio = modo.create(0)
    const { state, ruling } = modo.play(inicio as never, {
      firstContact: 1,
      pocketed: [8],
      offTable: [],
      railAfterContact: true,
      ballsToRail: 4,
      eightBallPocket: 2,
      called: null,
      nominated: null,
    } as never)

    expect((ruling as { pending: unknown }).pending).not.toBeNull()

    // 3 é o índice canônico de `respot-eight`.
    const r = modo.resolve(state as never, 3)
    expect(r.respot).toContain(8)
    expect(r.rerack).toBe(false)
  })

  test('cada situação oferece só as opções que a regra permite', () => {
    // A interface oferecia as quatro nas duas situações, e três mentiam:
    // "Aceitar a mesa" na 8 da quebra rearmava o rack, porque `resolveChoice`
    // manda tudo que não é `respot-eight` para o `default`.
    const modo = getGameMode('eightball')
    const inicio = modo.create(0)

    const { state } = modo.play(inicio as never, {
      firstContact: 1,
      pocketed: [8],
      offTable: [],
      railAfterContact: true,
      ballsToRail: 4,
      eightBallPocket: 2,
      called: null,
      nominated: null,
    } as never)

    const p = modo.pendingOf(state as never)
    expect(p).not.toBeNull()
    // A WPA 4.3(e) dá duas: recolocar a 8, ou quebrar de novo.
    expect(p!.options).toHaveLength(2)
    expect(p!.options.map((o) => o.index).sort()).toEqual([1, 3])
  })

  test('o índice canônico viaja com a opção, não é a posição na lista', () => {
    // A posição mudaria conforme a situação; o índice é o que fica gravado no
    // replay e não pode depender de quantas opções a tela mostrou.
    const modo = getGameMode('eightball')
    const inicio = modo.create(0)
    const { state } = modo.play(inicio as never, {
      firstContact: 1,
      pocketed: [8],
      offTable: [],
      railAfterContact: true,
      ballsToRail: 4,
      eightBallPocket: 2,
      called: null,
      nominated: null,
    } as never)

    const p = modo.pendingOf(state as never)!
    expect(p.options[0]!.index).not.toBe(0)
  })

  test('empate na sinuca encerra a partida em vez de deixá-la sem saída', () => {
    // Com a mesa vazia e placar igual, `winner` é null. Como o resumo olhava
    // só o vencedor, a partida seguia "em andamento": sem bola para jogar, a
    // falta por falta de contato era inevitável e os 7 pontos de penalidade
    // decidiam por quem estava na vez.
    const sinuca = getGameMode('sinuca')
    const estado = {
      ...(sinuca.create(0) as Record<string, unknown>),
      onTable: [],
      score: [28, 28],
      ending: { kind: 'all-balls-potted' },
      winner: null,
    }

    const resumo = sinuca.summarize(estado as never)
    expect(resumo.finished).toBe(true)
    expect(resumo.winner).toBeNull()
  })
})
