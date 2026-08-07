import { Time } from '@/game/core/time'
import { Viewport } from '@/game/core/viewport'
import type { FrameContext } from '@/game/core/entity'
import type { Input } from '@/game/core/input'
import { CallPocketObject } from '@/game/objects/CallPocketObject'
import { DecisionObject } from '@/game/objects/DecisionObject'
import { MatchController } from '@/game/objects/MatchController'
import { TargetBallObject } from '@/game/objects/TargetBallObject'
import { fixed as F, table as T } from '@zinc-pool/engine-physics'
import { getGameMode, eightball, sinuca } from '@zinc-pool/engine-rules'
import { decodeReplay, verifyReplay } from '@zinc-pool/replay'
import { describe, expect, test } from 'bun:test'

/**
 * A interface do hotseat só existe para o jogo não TRAVAR.
 *
 * Declarar a caçapa e responder a uma decisão pendente são condições que as
 * regras impõem antes da próxima tacada. Enquanto a mesa local não sabia
 * perguntar nenhuma das duas, a partida parava sem nada explicando — e a única
 * saída era recarregar a página.
 *
 * Por isso o que estes testes medem é sobretudo o que a interface se RECUSA a
 * fazer: aparecer fora de hora, aceitar clique fora do alvo, ou responder por
 * duas telas ao mesmo tempo numa mesa em rede.
 */

/** Ponteiro falso: os objetos leem posição e os sinais do quadro, nada mais. */
function ponteiro(x: number, y: number, soltou = true): Input {
  return {
    position: { x, y },
    pressStart: { x, y },
    isDown: false,
    pressedThisFrame: false,
    releasedThisFrame: soltou,
  } as unknown as Input
}

/** Contexto de quadro sem DOM. O canvas nunca é tocado pelos updates. */
function quadro(input: Input): FrameContext {
  return {
    time: new Time(F.toNumber(T.DT)),
    input,
    viewport: new Viewport(900, 520),
    ctx: null as unknown as CanvasRenderingContext2D,
  }
}

/** Onde uma caçapa aparece na tela, para simular o toque do jogador. */
function telaDaCacapa(indice: number, viewport: Viewport): { x: number; y: number } {
  const cacapa = T.POCKETS[indice]!
  return viewport.toScreenFixed(cacapa.center.x, cacapa.center.y)
}

/**
 * Mesa de 8-Ball com o jogador da vez já na bola 8.
 *
 * Chegar aqui jogando levaria dezenas de tacadas e dependeria da física; o que
 * interessa ao teste é a CONDIÇÃO, e ela é estado de regras.
 */
function naBolaOito(): MatchController {
  const match = new MatchController('eightball', 7)
  const estado = getGameMode('eightball').create(0) as unknown as eightball.MatchState

  match.rules = {
    ...estado,
    broken: true,
    groups: { open: false, first: 'solids', second: 'stripes' },
    pocketed: [...eightball.SOLIDS],
  } satisfies eightball.MatchState

  return match
}

describe('declarar a caçapa destrava a tacada', () => {
  test('sem declarar, a bola 8 não deixa tacar', () => {
    const match = naBolaOito()

    expect(match.callRequired).toBe(true)
    // O impasse original: mira sumida e nenhuma forma de continuar.
    expect(match.canShoot).toBe(false)
  })

  test('tocar numa caçapa declara e libera a mira', () => {
    const match = naBolaOito()
    const objeto = new CallPocketObject(match)

    const alvo = telaDaCacapa(4, quadro(ponteiro(0, 0)).viewport)
    objeto.update(quadro(ponteiro(alvo.x, alvo.y)))

    expect(match.calledPocket).toBe(4)
    expect(match.canShoot).toBe(true)
  })

  test('tocar longe de qualquer caçapa não declara nada', () => {
    // Um toque no meio do pano é o jogador tentando mirar, não escolhendo.
    const match = naBolaOito()
    const objeto = new CallPocketObject(match)
    const ctx = quadro(ponteiro(0, 0))

    const meio = ctx.viewport.toScreen(F.toNumber(T.WIDTH) / 2, F.toNumber(T.HEIGHT) / 2)
    objeto.update(quadro(ponteiro(meio.x, meio.y)))

    expect(match.calledPocket).toBeNull()
    expect(match.canShoot).toBe(false)
  })

  test('só o SOLTAR declara — arrastar por cima da caçapa não', () => {
    const match = naBolaOito()
    const objeto = new CallPocketObject(match)
    const alvo = telaDaCacapa(0, quadro(ponteiro(0, 0)).viewport)

    objeto.update(quadro(ponteiro(alvo.x, alvo.y, false)))

    expect(match.calledPocket).toBeNull()
  })

  test('a declaração vai para o replay, e o replay ainda verifica', () => {
    // Entrada não gravada faz a verificação reproduzir outra partida.
    const match = naBolaOito()
    const objeto = new CallPocketObject(match)
    const alvo = telaDaCacapa(2, quadro(ponteiro(0, 0)).viewport)

    objeto.update(quadro(ponteiro(alvo.x, alvo.y)))
    match.shoot(0.3, 0.8)

    const replay = match.recorder.build()
    expect(replay.calls).toEqual([{ ball: 8, pocket: 2 }])
    expect(() => verifyReplay(decodeReplay(match.recorder.toBytes()))).not.toThrow()
  })

  test('não pergunta quando a regra não exige declaração', () => {
    const objeto = new CallPocketObject(new MatchController('sinuca', 3))
    expect(objeto.ativo).toBe(false)
  })

  test('não pergunta numa mesa em rede', () => {
    // Lá quem pergunta é o painel em HTML; duas telas disputando a mesma
    // escolha deixariam a segunda sobrescrever a primeira.
    const match = naBolaOito()
    match.net = { you: 0, submit: () => {}, submitPlacement: () => {} }

    expect(new CallPocketObject(match).ativo).toBe(false)
  })

  test('não pergunta com a bola na mão em aberto', () => {
    // A ordem é das regras: primeiro a branca volta à mesa, depois se declara.
    const match = naBolaOito()
    match.rules = {
      ...(match.rules as eightball.MatchState),
      ballInHand: { active: true, region: 'anywhere' },
    }

    expect(new CallPocketObject(match).ativo).toBe(false)
  })
})

describe('decisão pendente tem resposta na mesa hotseat', () => {
  /** Mesa de 8-Ball com a escolha da quebra irregular aberta. */
  function comPendencia(): MatchController {
    const match = new MatchController('eightball', 5)
    const estado = getGameMode('eightball').create(0) as unknown as eightball.MatchState
    match.rules = { ...estado, pending: { kind: 'illegal-break', chooser: 1 } }
    return match
  }

  test('enquanto a escolha está aberta, não há tacada possível', () => {
    const match = comPendencia()
    expect(match.pending).not.toBeNull()
    expect(match.canShoot).toBe(false)
  })

  test('clicar numa opção resolve e devolve a mesa ao jogo', () => {
    const match = comPendencia()
    const objeto = new DecisionObject(match)
    const ctx = quadro(ponteiro(0, 0))

    // Aceitar a mesa é a primeira opção; o centro dela é onde ela é desenhada.
    const centro = {
      x: ctx.viewport.offsetX + ctx.viewport.tableWidthPx / 2,
      y: ctx.viewport.offsetY + ctx.viewport.tableHeightPx / 2 - 30,
    }

    let resolveu = false
    for (let dy = -60; dy <= 60 && !resolveu; dy += 4) {
      objeto.update(quadro(ponteiro(centro.x, centro.y + dy)))
      resolveu = match.pending === null
    }

    expect(resolveu).toBe(true)
    expect(match.canShoot).toBe(true)
    // Escolha é entrada do jogador: sem gravar, o replay reproduz outra
    // partida a partir daqui.
    expect(match.recorder.decisionCount).toBe(1)
  })

  test('clicar fora dos botões não escolhe nada', () => {
    const match = comPendencia()
    const objeto = new DecisionObject(match)

    // Canto superior esquerdo do pano: longe da coluna de botões.
    const ctx = quadro(ponteiro(0, 0))
    objeto.update(quadro(ponteiro(ctx.viewport.offsetX + 6, ctx.viewport.offsetY + 6)))

    expect(match.pending).not.toBeNull()
    expect(match.recorder.decisionCount).toBe(0)
  })

  test('não aparece numa mesa em rede', () => {
    const match = comPendencia()
    match.net = { you: 0, submit: () => {}, submitPlacement: () => {} }

    expect(new DecisionObject(match).ativo).toBe(false)
  })

  test('sem pendência, o objeto não come o clique da mira', () => {
    const match = new MatchController('eightball', 5)
    const objeto = new DecisionObject(match)

    expect(objeto.ativo).toBe(false)
    expect(() => objeto.update(quadro(ponteiro(400, 260)))).not.toThrow()
    expect(match.canShoot).toBe(true)
  })
})

describe('a bola da vez é identificável na mesa', () => {
  test('a sinuca aponta a menor bola ainda na mesa', () => {
    const match = new MatchController('sinuca', 3)
    expect(match.targetBall).toBe(1)

    const estado = match.rules as sinuca.SinucaState
    match.rules = { ...estado, onTable: [3, 5, 7] }
    expect(match.targetBall).toBe(3)
  })

  test('a bola livre declarada substitui a da vez', () => {
    // Se o destaque ignorasse a declaração, a mesa apontaria uma bola e o
    // julgamento cobraria outra.
    const match = new MatchController('sinuca', 3)
    match.rules = { ...(match.rules as sinuca.SinucaState), nominated: 6 }

    expect(match.targetBall).toBe(6)
  })

  test('o 8-Ball não aponta bola nenhuma', () => {
    // O alvo lá é o grupo inteiro; destacar uma bola inventaria uma obrigação.
    expect(new MatchController('eightball', 3).targetBall).toBeNull()
  })

  test('não desenha enquanto as bolas rolam', () => {
    // Apontar a bola da próxima tacada durante a simulação entregaria o
    // resultado antes de ele acontecer.
    const match = new MatchController('sinuca', 3)
    const objeto = new TargetBallObject(match)

    match.shoot(0.2, 0.9)
    expect(match.phase).toBe('simulating')

    // Sem contexto de canvas, desenhar qualquer coisa lançaria.
    expect(() => objeto.render(quadro(ponteiro(0, 0)))).not.toThrow()
  })

  test('mesa vazia não tem bola da vez', () => {
    const match = new MatchController('sinuca', 3)
    match.rules = { ...(match.rules as sinuca.SinucaState), onTable: [] }

    expect(match.targetBall).toBeNull()
  })
})

describe('os tetos do replay recusam em vez de derrubar a página', () => {
  test('sem espaço para declarar, a tacada é recusada com mensagem', () => {
    // O gravador LANÇA ao estourar, e este erro vinha de dentro do laço do
    // jogo: a mesa inteira parava de responder.
    const match = naBolaOito()
    // O limite é lido UMA vez: `remainingCalls` cai a cada gravação, e usá-lo
    // na condição encheria só metade do espaço.
    const cabem = match.recorder.remainingCalls
    for (let i = 0; i < cabem; i++) match.recorder.recordCall(8, 0)

    match.calledPocket = 0
    const antes = match.recorder.shotCount

    expect(() => match.shoot(0.3, 0.8)).not.toThrow()
    expect(match.recorder.shotCount).toBe(antes)
    expect(match.lastMessage).toContain('declarações')
  })

  test('sem espaço para posicionar, a bola na mão é recusada com mensagem', () => {
    const match = new MatchController('eightball', 9)
    match.rules = {
      ...(match.rules as eightball.MatchState),
      ballInHand: { active: true, region: 'anywhere' },
    }

    const cabem = match.recorder.remainingPlacements
    for (let i = 0; i < cabem; i++) match.recorder.placeCueBall(0.5, 0.5)

    expect(() => match.placeCueBall(0.6, 0.4)).not.toThrow()
    expect(match.lastMessage).toContain('posicionamentos')
    // A bola na mão continua aberta: nada foi aplicado pela metade.
    expect(match.ballInHand).toBe('anywhere')
  })
})
