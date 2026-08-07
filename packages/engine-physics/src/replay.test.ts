import { describe, expect, test } from 'bun:test'
import { CUE_LIMITS, clampCue, DEFAULT_CUE } from './cue'
import * as F from './fixed'
import { hashEvents, hashState } from './hash'
import {
  applyShot,
  BALL_JITTER,
  CUE_BALL,
  jitterFromSeed,
  RACK_GAP,
  rackBalls,
} from './replay'
import { cloneState, isMoving, step as stepOnce } from './sim'
import * as T from './table'
import * as V from './vec'

const n = (v: F.Fixed) => F.toNumber(v)

const tacada = (anguloGraus: number, forca: number) => ({
  intent: { angle: F.from((anguloGraus * Math.PI) / 180), power: F.from(forca) },
})

describe('montagem do triângulo', () => {
  test('16 bolas, todas dentro da mesa e sem sobreposição', () => {
    const estado = rackBalls()
    expect(estado.balls).toHaveLength(16)

    for (const bola of estado.balls) {
      expect(T.isInsideBounds(bola.position)).toBe(true)
      expect(V.isZero(bola.velocity)).toBe(true)
    }

    for (let i = 0; i < estado.balls.length; i++) {
      for (let j = i + 1; j < estado.balls.length; j++) {
        const separacao = V.distance(estado.balls[i]!.position, estado.balls[j]!.position)
        expect(separacao).toBeGreaterThanOrEqual(T.CONTACT_DISTANCE)
      }
    }
  })

  test('a mesa montada está em repouso — nenhuma colisão antes da primeira tacada', () => {
    const estado = rackBalls()
    expect(isMoving(estado)).toBe(false)
  })

  test('a branca fica na linha da cabeça, longe do triângulo', () => {
    const estado = rackBalls()
    const branca = estado.balls[CUE_BALL]!
    expect(n(branca.position.x)).toBeLessThan(n(T.FOOT_SPOT.x))
  })

  test('montar duas vezes dá exatamente a mesma mesa', () => {
    expect(hashState(rackBalls())).toBe(hashState(rackBalls()))
  })
})

describe('jitter da quebra', () => {
  test('seeds diferentes movem as bolas', () => {
    const a = rackBalls(jitterFromSeed(new Uint8Array(32).fill(10)))
    const b = rackBalls(jitterFromSeed(new Uint8Array(32).fill(200)))
    expect(hashState(a)).not.toBe(hashState(b))
  })

  test('o mesmo seed dá sempre a mesma mesa', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256)
    expect(hashState(rackBalls(jitterFromSeed(seed)))).toBe(
      hashState(rackBalls(jitterFromSeed(seed))),
    )
  })

  test('o deslocamento é sub-milimétrico e não cria sobreposição', () => {
    for (const preenchimento of [0, 64, 128, 255]) {
      const estado = rackBalls(jitterFromSeed(new Uint8Array(32).fill(preenchimento)))

      for (let i = 0; i < estado.balls.length; i++) {
        for (let j = i + 1; j < estado.balls.length; j++) {
          const separacao = V.distance(estado.balls[i]!.position, estado.balls[j]!.position)
          expect(separacao).toBeGreaterThanOrEqual(T.CONTACT_DISTANCE - F.from(0.0001))
        }
      }
    }
  })

  test('muda o resultado da quebra — é a razão de existir', () => {
    const quebrar = (preenchimento: number) => {
      const estado = rackBalls(jitterFromSeed(new Uint8Array(32).fill(preenchimento)))
      return applyShot(estado, tacada(0, 1)).stateHash
    }
    expect(quebrar(20)).not.toBe(quebrar(230))
  })
})

describe('tacada', () => {
  test('a branca sai na direção pedida', () => {
    const estado = rackBalls()
    const antes = V.clone(estado.balls[CUE_BALL]!.position)
    applyShot(estado, tacada(0, 0.3))

    expect(n(estado.balls[CUE_BALL]!.position.x)).toBeGreaterThan(n(antes.x))
  })

  test('força zero não move nada', () => {
    const estado = rackBalls()
    const antes = hashState(estado)
    const resultado = applyShot(estado, tacada(0, 0))

    expect(hashState(estado)).toBe(antes)
    expect(resultado.events).toHaveLength(0)
  })

  test('força é limitada a 1 — não existe tacada de força 5', () => {
    const normal = rackBalls()
    const exagerada = rackBalls()

    applyShot(normal, { intent: { angle: 0, power: F.ONE } })
    applyShot(exagerada, { intent: { angle: 0, power: F.from(5) } })

    expect(hashState(normal)).toBe(hashState(exagerada))
  })

  test('a quebra espalha as bolas', () => {
    const estado = rackBalls()
    const resultado = applyShot(estado, tacada(0, 1))

    expect(resultado.events.some((e) => e.type === 'ball-ball')).toBe(true)
    expect(isMoving(estado)).toBe(false)

    // Todas terminaram dentro da mesa ou na caçapa.
    for (const bola of estado.balls) {
      if (!bola.pocketed) expect(T.isInsideBounds(bola.position)).toBe(true)
    }
  })

  test('tacar com a branca encaçapada é erro, não comportamento estranho', () => {
    const estado = rackBalls()
    estado.balls[CUE_BALL]!.pocketed = true
    expect(() => applyShot(estado, tacada(0, 0.5))).toThrow()
  })
})

describe('taco', () => {
  test('taco mais forte imprime mais velocidade', () => {
    // Mede o CAMINHO percorrido pela branca: ela quica nas tabelas, então a
    // posição final não cresce junto com a força.
    const caminho = (massBps: number) => {
      const estado = rackBalls()
      const branca = estado.balls[CUE_BALL]!

      const direcao = V.fromAngle(F.PI)
      const velocidade = F.mul(
        F.mul(F.from(12), F.from(0.2)),
        F.from(massBps / 10_000),
      )
      V.set(branca.velocity, F.mul(direcao.x, velocidade), F.mul(direcao.y, velocidade))

      let total = 0
      let anterior = V.clone(branca.position)
      for (let i = 0; i < T.MAX_STEPS && isMoving(estado); i++) {
        stepOnce(estado)
        total += n(V.distance(anterior, branca.position))
        anterior = V.clone(branca.position)
      }
      return total
    }
    expect(caminho(CUE_LIMITS.maxMassBps)).toBeGreaterThan(caminho(CUE_LIMITS.minMassBps))
  })

  test('atributos fora da faixa são prendidos, não aceitos', () => {
    const absurdo = clampCue({ massBps: 999_999, spinBps: -50 })
    expect(absurdo.massBps).toBe(CUE_LIMITS.maxMassBps)
    expect(absurdo.spinBps).toBe(CUE_LIMITS.minSpinBps)
  })

  test('taco absurdo não dá vantagem além do teto', () => {
    const noTeto = rackBalls()
    const absurdo = rackBalls()

    applyShot(noTeto, {
      intent: { angle: 0, power: F.ONE },
      cue: { massBps: CUE_LIMITS.maxMassBps, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })
    applyShot(absurdo, {
      intent: { angle: 0, power: F.ONE },
      cue: { massBps: 500_000, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })

    expect(hashState(noTeto)).toBe(hashState(absurdo))
  })

  test('valores inválidos viram taco comum, não taco máximo', () => {
    // NaN e Infinity são entrada corrompida. Cair para o neutro é seguro;
    // cair para o teto premiaria quem mandasse lixo.
    const invalido = clampCue({ massBps: Number.NaN, spinBps: Number.POSITIVE_INFINITY })
    expect(invalido.massBps).toBe(DEFAULT_CUE.massBps)
    expect(invalido.spinBps).toBe(DEFAULT_CUE.spinBps)
  })

  test('o taco aplicado volta no resultado — precisa entrar no replay', () => {
    const estado = rackBalls()
    const resultado = applyShot(estado, {
      intent: { angle: 0, power: F.from(0.5) },
      cue: { massBps: 20_000, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })
    // Grava o que foi APLICADO, não o que foi pedido.
    expect(resultado.cue.massBps).toBe(CUE_LIMITS.maxMassBps)
  })

  test('sem taco informado, usa o comum', () => {
    const estado = rackBalls()
    const resultado = applyShot(estado, tacada(0, 0.5))
    expect(resultado.cue).toEqual(DEFAULT_CUE)
  })

  test('taco diferente muda o resultado — por isso vai no replay', () => {
    const comum = rackBalls()
    const forte = rackBalls()

    const a = applyShot(comum, { intent: { angle: 0, power: F.ONE }, cue: DEFAULT_CUE })
    const b = applyShot(forte, {
      intent: { angle: 0, power: F.ONE },
      cue: { massBps: CUE_LIMITS.maxMassBps, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })

    expect(a.stateHash).not.toBe(b.stateHash)
  })
})

describe('reprodutibilidade da partida', () => {
  test('a mesma sequência de tacadas dá o mesmo resultado', () => {
    const jogar = () => {
      const estado = rackBalls(jitterFromSeed(new Uint8Array(32).fill(77)))
      const hashes: string[] = []

      for (const [angulo, forca] of [
        [0, 1],
        [30, 0.6],
        [200, 0.8],
        [95, 0.4],
        [310, 0.9],
      ] as const) {
        if (estado.balls[CUE_BALL]!.pocketed) {
          // Bola na mão: recoloca no ponto de saque, de forma determinística.
          estado.balls[CUE_BALL]!.pocketed = false
          V.copy(estado.balls[CUE_BALL]!.position, T.CUE_SPOT)
        }
        hashes.push(applyShot(estado, tacada(angulo, forca)).stateHash)
      }
      return hashes.join('|')
    }

    expect(jogar()).toBe(jogar())
  })

  test('o replay reconstrói o estado final a partir de seed e tacadas', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256)
    const tacadas = [tacada(5, 1), tacada(120, 0.55), tacada(250, 0.7)]

    const reproduzir = () => {
      const estado = rackBalls(jitterFromSeed(seed))
      for (const t of tacadas) {
        if (estado.balls[CUE_BALL]!.pocketed) {
          estado.balls[CUE_BALL]!.pocketed = false
          V.copy(estado.balls[CUE_BALL]!.position, T.CUE_SPOT)
        }
        applyShot(estado, t)
      }
      return hashState(estado)
    }

    expect(reproduzir()).toBe(reproduzir())
  })

  test('mudar uma tacada muda o resultado', () => {
    const jogar = (segundoAngulo: number) => {
      const estado = rackBalls()
      applyShot(estado, tacada(0, 1))
      if (!estado.balls[CUE_BALL]!.pocketed) applyShot(estado, tacada(segundoAngulo, 0.5))
      return hashState(estado)
    }
    expect(jogar(45)).not.toBe(jogar(46))
  })

  test('o hash de eventos é estável', () => {
    const rodar = () => {
      const estado = rackBalls(jitterFromSeed(new Uint8Array(32).fill(3)))
      return applyShot(estado, tacada(2, 0.95)).eventsHash
    }
    expect(rodar()).toBe(rodar())
  })

  test('hash de estado e de eventos são independentes', () => {
    const estado = rackBalls()
    const resultado = applyShot(estado, tacada(0, 1))
    expect(resultado.stateHash).not.toBe(resultado.eventsHash)
    expect(resultado.stateHash).toHaveLength(8)
    expect(resultado.eventsHash).toHaveLength(8)
  })
})

describe('hash', () => {
  test('estados iguais dão hashes iguais', () => {
    const a = rackBalls()
    expect(hashState(a)).toBe(hashState(cloneState(a)))
  })

  test('um lamport de diferença muda o hash', () => {
    const a = rackBalls()
    const b = cloneState(a)
    b.balls[3]!.position.x += 1

    expect(hashState(a)).not.toBe(hashState(b))
  })

  test('encaçapar muda o hash mesmo com a posição igual', () => {
    const a = rackBalls()
    const b = cloneState(a)
    b.balls[5]!.pocketed = true

    expect(hashState(a)).not.toBe(hashState(b))
  })

  test('lista de eventos vazia tem hash estável', () => {
    expect(hashEvents([])).toBe(hashEvents([]))
    expect(hashEvents([])).toHaveLength(8)
  })
})

describe('o rack nunca nasce com bolas sobrepostas', () => {
  /**
   * A guarda que faltava na v1.
   *
   * O jitter desloca as bolas em CADA eixo, então o deslocamento diagonal vale
   * amplitude·√2 — e é ele, não o de um eixo, que precisa caber na folga do
   * rack. A v1 errava essa conta e sobrepunha bolas em quase todo rack, sem
   * nada acusando: a simulação simplesmente começava resolvendo colisões que
   * não deviam existir.
   */
  const seeds = Array.from({ length: 300 }, (_, s) =>
    Uint8Array.from({ length: 32 }, (_, i) => (s * 7919 + i * 131 + s * i) % 256),
  )

  test('nenhum par de bolas viola a distância de contato', () => {
    for (const seed of seeds) {
      const { balls } = rackBalls(jitterFromSeed(seed))
      for (let a = 0; a < balls.length; a++) {
        for (let b = a + 1; b < balls.length; b++) {
          const d = V.length(V.sub(balls[a]!.position, balls[b]!.position))
          expect(d).toBeGreaterThanOrEqual(T.CONTACT_DISTANCE)
        }
      }
    }
  })

  test('a amplitude do jitter cabe na folga do rack, na diagonal', () => {
    // Se alguém aumentar BALL_JITTER, é aqui que descobre por que não pode.
    //
    // A faixa REAL é medida, não deduzida da constante: o `floor` do
    // mapeamento a torna assimétrica, e foi exatamente essa diferença que
    // sobrepôs as bolas quando o valor foi calibrado só pela amplitude
    // nominal.
    let maiorDeslocamento = 0
    for (let byte = 0; byte < 256; byte++) {
      const seed = new Uint8Array(32).fill(byte)
      // Neutraliza o deslize do rack para medir só a parcela por bola.
      seed[30] = 128
      seed[31] = 128
      for (const v of jitterFromSeed(seed)) {
        maiorDeslocamento = Math.max(maiorDeslocamento, Math.abs(v))
      }
    }

    expect(maiorDeslocamento).toBeGreaterThanOrEqual(BALL_JITTER)
    expect(2 * maiorDeslocamento * Math.SQRT2).toBeLessThan(RACK_GAP)
  })

  test('o deslize do rack move todas as bolas junto', () => {
    // Se movesse só algumas, a folga entre elas mudaria e o teste acima cairia.
    const semDeslize = new Uint8Array(32).fill(128)
    const comDeslize = new Uint8Array(32).fill(128)
    comDeslize[30] = 255
    comDeslize[31] = 255

    const a = rackBalls(jitterFromSeed(semDeslize)).balls
    const b = rackBalls(jitterFromSeed(comDeslize)).balls

    // Descarta a branca, que não faz parte do triângulo.
    const deltas = a
      .slice(1)
      .map((bola, i) => `${b[i + 1]!.position.x - bola.position.x},${b[i + 1]!.position.y - bola.position.y}`)

    expect(new Set(deltas).size).toBe(1)
  })

  test('o deslize usa a entropia inteira do byte', () => {
    const posicoes = new Set(
      Array.from({ length: 256 }, (_, byte) => {
        const seed = new Uint8Array(32)
        seed[30] = byte
        return jitterFromSeed(seed)[0]
      }),
    )
    expect(posicoes.size).toBe(256)
  })
})
