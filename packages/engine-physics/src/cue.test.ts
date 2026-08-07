import { describe, expect, test } from 'bun:test'
import {
  aimSlotsFor,
  aimStepFor,
  BASE_AIM_STEP,
  clampCue,
  CUE_ARCHETYPES,
  CUE_LIMITS,
  DEFAULT_CUE,
  effectiveAimBps,
  isDefaultCue,
  paramsFromNft,
  quantizeAim,
  shotPowerBpsFor,
  spinDecayFor,
  CUE_SCHEMA_VERSION,
  type CueNft,
} from './cue'
import * as F from './fixed'
import { hashState } from './hash'
import { applyShot, CUE_BALL, rackBalls } from './replay'
import * as V from './vec'

const graus = (g: number) => F.from((g * Math.PI) / 180)
const paraGraus = (f: F.Fixed) => (F.toNumber(f) * 180) / Math.PI

describe('limites', () => {
  test('valores absurdos são prendidos', () => {
    const preso = clampCue({ massBps: 10_000_000, spinBps: -999, aimBps: 1, clothGripBps: 10_000, breakBonusBps: 10_000 })

    expect(preso.massBps).toBe(CUE_LIMITS.maxMassBps)
    expect(preso.spinBps).toBe(CUE_LIMITS.minSpinBps)
    expect(preso.aimBps).toBe(CUE_LIMITS.minAimBps)
  })

  test('entrada corrompida cai para o padrão, não para o teto', () => {
    // Premiar quem manda NaN seria criar um exploit.
    const invalido = clampCue({
      massBps: Number.NaN,
      spinBps: Number.POSITIVE_INFINITY,
      aimBps: Number.NEGATIVE_INFINITY,
    })
    expect(invalido).toEqual(DEFAULT_CUE)
  })

  test('campos ausentes viram padrão', () => {
    expect(clampCue({})).toEqual(DEFAULT_CUE)
    expect(clampCue({ massBps: 11_000 })).toEqual({ ...DEFAULT_CUE, massBps: 11_000 })
  })

  test('a faixa de peso é estreita — no máximo ±15%', () => {
    expect(CUE_LIMITS.maxMassBps / CUE_LIMITS.minMassBps).toBeLessThan(1.4)
  })

  test('isDefaultCue reconhece o taco comum', () => {
    expect(isDefaultCue(DEFAULT_CUE)).toBe(true)
    expect(isDefaultCue({ ...DEFAULT_CUE, massBps: 11_000 })).toBe(false)
  })
})

describe('mira quantizada', () => {
  test('o taco padrão trava em meio grau', () => {
    expect(Math.abs(paraGraus(aimStepFor(DEFAULT_CUE)) - 0.5)).toBeLessThan(0.01)
  })

  test('taco melhor mira mais fino', () => {
    const fino = aimStepFor({ massBps: 10_000, spinBps: 10_000, aimBps: 5_000, clothGripBps: 10_000, breakBonusBps: 10_000 })
    const grosso = aimStepFor({ massBps: 10_000, spinBps: 10_000, aimBps: 20_000, clothGripBps: 10_000, breakBonusBps: 10_000 })

    expect(fino).toBeLessThan(aimStepFor(DEFAULT_CUE))
    expect(grosso).toBeGreaterThan(aimStepFor(DEFAULT_CUE))
  })

  test('encaixa o ângulo na grade, sem costura na volta completa', () => {
    const passo = aimStepFor(DEFAULT_CUE)
    // Inclui 359.9: é onde uma grade mal fechada saltaria mais que um passo.
    for (const alvo of [0, 10, 45, 123.7, 270, 359.9, 359.99]) {
      const encaixado = quantizeAim(graus(alvo), DEFAULT_CUE)
      const desvio = Math.abs(paraGraus(encaixado) - alvo)

      expect(Math.min(desvio, 360 - desvio)).toBeLessThanOrEqual(paraGraus(passo))
    }
  })

  test('encaixar de novo não muda nada', () => {
    // Idempotência: um ângulo já na grade permanece onde está. Sem isso, o
    // servidor reprocessando o replay moveria a tacada a cada rodada.
    for (const alvo of [0, 37.3, 180, 359.9]) {
      const uma = quantizeAim(graus(alvo), DEFAULT_CUE)
      expect(quantizeAim(uma, DEFAULT_CUE)).toBe(uma)
    }
  })

  test('a grade cobre a volta inteira sem repetir nem faltar casa', () => {
    const casas = aimSlotsFor(DEFAULT_CUE)
    const vistos = new Set<number>()

    for (let i = 0; i < casas; i++) {
      const angulo = Math.floor((i * F.TAU) / casas)
      vistos.add(quantizeAim(angulo, DEFAULT_CUE))
    }
    expect(vistos.size).toBe(casas)
  })

  test('é determinístico — nada de sorteio', () => {
    // Se houvesse erro aleatório, duas chamadas divergiriam e o replay
    // deixaria de reproduzir a partida.
    for (const angulo of [graus(37.3), graus(180.1), graus(299.99)]) {
      expect(quantizeAim(angulo, DEFAULT_CUE)).toBe(quantizeAim(angulo, DEFAULT_CUE))
    }
  })

  test('ângulos próximos caem no mesmo ponto com taco grosso e em pontos diferentes com taco fino', () => {
    const grosso = { massBps: 10_000, spinBps: 10_000, aimBps: 20_000, clothGripBps: 10_000, breakBonusBps: 10_000 }
    const fino = { massBps: 10_000, spinBps: 10_000, aimBps: 5_000, clothGripBps: 10_000, breakBonusBps: 10_000 }

    const a = graus(45)
    const b = graus(45.2)

    expect(quantizeAim(a, grosso)).toBe(quantizeAim(b, grosso))
    expect(quantizeAim(a, fino)).not.toBe(quantizeAim(b, fino))
  })

  test('a grade nunca é zero — evitaria divisão por zero', () => {
    for (const aimBps of [CUE_LIMITS.minAimBps, 1, 0]) {
      expect(aimStepFor(clampCue({ aimBps }))).toBeGreaterThan(0)
    }
  })
})

describe('trade-off peso × mira', () => {
  test('peso maior engrossa a mira', () => {
    const leve = effectiveAimBps({ massBps: 8_500, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 })
    const pesado = effectiveAimBps({ massBps: 11_500, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 })

    expect(pesado).toBeGreaterThan(leve)
  })

  test('nenhum arquétipo domina os outros', () => {
    // A propriedade que impede o jogo de virar "quem pagou mais ganha":
    // para todo par de tacos, cada um é melhor em ALGUMA coisa.
    const arquetipos = Object.entries(CUE_ARCHETYPES)

    for (const [nomeA, a] of arquetipos) {
      for (const [nomeB, b] of arquetipos) {
        if (nomeA === nomeB) continue

        const aDomina =
          a.massBps >= b.massBps &&
          a.spinBps >= b.spinBps &&
          effectiveAimBps(a) <= effectiveAimBps(b) &&
          (a.massBps > b.massBps ||
            a.spinBps > b.spinBps ||
            effectiveAimBps(a) < effectiveAimBps(b))

        expect(`${nomeA} domina ${nomeB}: ${aDomina}`).toBe(`${nomeA} domina ${nomeB}: false`)
      }
    }
  })

  test('o pesado bate mais forte que o preciso', () => {
    const velocidadeInicial = (cue: typeof DEFAULT_CUE) => {
      const estado = rackBalls()
      const branca = estado.balls[CUE_BALL]!
      // Mede antes de simular: aplica a tacada num estado sem outras bolas.
      const sozinha = { balls: [branca] }
      applyShot(sozinha, { intent: { angle: graus(180), power: F.ONE }, cue })
      return true
    }
    expect(velocidadeInicial(CUE_ARCHETYPES.pesado)).toBe(true)

    // Comparação real: caminho percorrido pela branca isolada.
    const caminho = (cue: typeof DEFAULT_CUE) => {
      const estado = rackBalls()
      const antes = V.clone(estado.balls[CUE_BALL]!.position)
      applyShot(estado, { intent: { angle: graus(90), power: F.from(0.15) }, cue })
      return F.toNumber(V.distance(antes, estado.balls[CUE_BALL]!.position))
    }
    expect(caminho(CUE_ARCHETYPES.pesado)).toBeGreaterThan(caminho(CUE_ARCHETYPES.preciso))
  })
})

describe('efeito', () => {
  test('sem efeito informado, a branca não gira', () => {
    const estado = rackBalls()
    applyShot(estado, { intent: { angle: graus(180), power: F.from(0.2) } })
    expect(V.isZero(estado.balls[CUE_BALL]!.spin)).toBe(true)
  })

  test('efeito muda o resultado da tacada', () => {
    const semEfeito = rackBalls()
    const comEfeito = rackBalls()

    applyShot(semEfeito, { intent: { angle: 0, power: F.from(0.8) } })
    applyShot(comEfeito, {
      intent: { angle: 0, power: F.from(0.8), spin: { x: F.ONE, y: F.ONE } },
    })

    expect(hashState(semEfeito)).not.toBe(hashState(comEfeito))
  })

  test('recuo e corrida levam a resultados diferentes', () => {
    const rodar = (y: F.Fixed) => {
      const estado = rackBalls()
      applyShot(estado, { intent: { angle: 0, power: F.from(0.7), spin: { x: 0, y } } })
      return hashState(estado)
    }
    expect(rodar(F.ONE)).not.toBe(rodar(-F.ONE))
  })

  test('taco com mais autoridade imprime mais efeito', () => {
    // Efeito VERTICAL: age no contato entre bolas, que é o que esta tacada
    // provoca. O lateral só se manifesta na tabela.
    const rodar = (spinBps: number) => {
      const estado = rackBalls()
      applyShot(estado, {
        intent: { angle: 0, power: F.from(0.7), spin: { x: 0, y: F.ONE } },
        cue: { ...DEFAULT_CUE, spinBps },
      })
      return hashState(estado)
    }
    expect(rodar(CUE_LIMITS.minSpinBps)).not.toBe(rodar(CUE_LIMITS.maxSpinBps))
  })

  test('efeito lateral age na tabela', () => {
    // Tacada para a tabela de cima, longe do triângulo.
    const rodar = (x: F.Fixed) => {
      const estado = rackBalls()
      applyShot(estado, { intent: { angle: graus(90), power: F.from(0.6), spin: { x, y: 0 } } })
      return hashState(estado)
    }
    expect(rodar(F.ONE)).not.toBe(rodar(-F.ONE))
  })

  test('ponto de contato fora de -1..1 é prendido', () => {
    const noLimite = rackBalls()
    const absurdo = rackBalls()

    applyShot(noLimite, { intent: { angle: 0, power: F.from(0.5), spin: { x: F.ONE, y: 0 } } })
    applyShot(absurdo, {
      intent: { angle: 0, power: F.from(0.5), spin: { x: F.from(50), y: 0 } },
    })

    expect(hashState(noLimite)).toBe(hashState(absurdo))
  })

  test('efeito não impede a simulação de terminar', () => {
    const estado = rackBalls()
    applyShot(estado, {
      intent: { angle: graus(10), power: F.ONE, spin: { x: F.ONE, y: -F.ONE } },
      cue: { massBps: CUE_LIMITS.maxMassBps, spinBps: CUE_LIMITS.maxSpinBps, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })

    for (const bola of estado.balls) {
      expect(V.isZero(bola.velocity)).toBe(true)
      expect(() => V.check(bola.spin)).not.toThrow()
    }
  })

  test('a tacada é determinística com efeito', () => {
    const rodar = () => {
      const estado = rackBalls()
      return applyShot(estado, {
        intent: { angle: graus(23), power: F.from(0.85), spin: { x: F.from(0.7), y: F.from(-0.4) } },
        cue: CUE_ARCHETYPES.efeito,
      }).stateHash
    }
    expect(rodar()).toBe(rodar())
  })
})

describe('o taco vai para o replay', () => {
  test('o resultado registra o taco aplicado, não o pedido', () => {
    const estado = rackBalls()
    const resultado = applyShot(estado, {
      intent: { angle: 0, power: F.from(0.5) },
      cue: { massBps: 99_999, spinBps: 10_000, aimBps: 10_000, clothGripBps: 10_000, breakBonusBps: 10_000 },
    })
    expect(resultado.cue.massBps).toBe(CUE_LIMITS.maxMassBps)
  })

  test('o resultado registra o ângulo depois da grade', () => {
    const estado = rackBalls()
    const pedido = graus(45.37)
    const resultado = applyShot(estado, { intent: { angle: pedido, power: F.from(0.4) } })

    expect(resultado.aimedAngle).toBe(quantizeAim(pedido, DEFAULT_CUE))
    expect(resultado.aimedAngle).not.toBe(pedido)
  })

  test('mesmo pedido com tacos diferentes pode virar tacadas diferentes', () => {
    const rodar = (aimBps: number) => {
      const estado = rackBalls()
      return applyShot(estado, {
        intent: { angle: graus(30.4), power: F.from(0.9) },
        cue: { ...DEFAULT_CUE, aimBps },
      }).aimedAngle
    }
    expect(rodar(5_000)).not.toBe(rodar(20_000))
  })
})

describe('aderência do couro', () => {
  test('mais aderência segura o efeito por mais tempo', () => {
    expect(spinDecayFor({ ...DEFAULT_CUE, clothGripBps: CUE_LIMITS.maxClothGripBps })).toBeGreaterThan(
      spinDecayFor({ ...DEFAULT_CUE, clothGripBps: CUE_LIMITS.minClothGripBps }),
    )
  })

  test('o decaimento nunca chega a 1 — efeito eterno travaria a simulação', () => {
    for (const clothGripBps of [CUE_LIMITS.maxClothGripBps, 99_999]) {
      const taxa = spinDecayFor(clampCue({ clothGripBps }))
      expect(taxa).toBeLessThan(F.ONE)
      expect(taxa).toBeGreaterThan(0)
    }
  })

  test('muda o resultado de uma tacada com efeito', () => {
    const rodar = (clothGripBps: number) => {
      const estado = rackBalls()
      applyShot(estado, {
        intent: { angle: graus(90), power: F.from(0.7), spin: { x: F.ONE, y: 0 } },
        cue: clampCue({ clothGripBps }),
      })
      return hashState(estado)
    }
    expect(rodar(CUE_LIMITS.minClothGripBps)).not.toBe(rodar(CUE_LIMITS.maxClothGripBps))
  })
})

describe('bônus de quebra', () => {
  test('só vale na quebra', () => {
    const comBonus = { ...DEFAULT_CUE, breakBonusBps: CUE_LIMITS.maxBreakBonusBps }

    expect(shotPowerBpsFor(comBonus, true)).toBeGreaterThan(comBonus.massBps)
    expect(shotPowerBpsFor(comBonus, false)).toBe(comBonus.massBps)
  })

  test('taco sem bônus quebra igual em qualquer situação', () => {
    expect(shotPowerBpsFor(DEFAULT_CUE, true)).toBe(shotPowerBpsFor(DEFAULT_CUE, false))
  })

  test('a quebra sai diferente com e sem o bônus', () => {
    const rodar = (breakBonusBps: number) => {
      const estado = rackBalls()
      applyShot(estado, {
        intent: { angle: 0, power: F.ONE },
        cue: clampCue({ breakBonusBps }),
        isBreak: true,
      })
      return hashState(estado)
    }
    expect(rodar(10_000)).not.toBe(rodar(CUE_LIMITS.maxBreakBonusBps))
  })

  test('fora da quebra o bônus não dá vantagem', () => {
    const rodar = (breakBonusBps: number) => {
      const estado = rackBalls()
      applyShot(estado, {
        intent: { angle: 0, power: F.from(0.6) },
        cue: clampCue({ breakBonusBps }),
        isBreak: false,
      })
      return hashState(estado)
    }
    expect(rodar(10_000)).toBe(rodar(CUE_LIMITS.maxBreakBonusBps))
  })

  test('o bônus nunca reduz a potência', () => {
    expect(CUE_LIMITS.minBreakBonusBps).toBeGreaterThanOrEqual(10_000)
  })
})

describe('NFT', () => {
  const nftBase: CueNft = {
    schemaVersion: CUE_SCHEMA_VERSION,
    mint: 'Cue111111111111111111111111111111111111111',
    serial: 42,
    mintedAtSlot: 481_000_000,
    params: CUE_ARCHETYPES.pesado,
    cosmetic: { name: 'Martelo', skin: 'ebano' },
  }

  test('extrai os parâmetros já limitados', () => {
    const params = paramsFromNft({
      schemaVersion: CUE_SCHEMA_VERSION,
      params: { ...DEFAULT_CUE, massBps: 999_999 },
    })
    expect(params.massBps).toBe(CUE_LIMITS.maxMassBps)
  })

  test('esquema desconhecido cai para o taco padrão', () => {
    // Metadados de uma versão futura podem significar outra coisa; confiar
    // neles seria aceitar atributos que este código não sabe interpretar.
    const params = paramsFromNft({
      schemaVersion: 999,
      params: { ...DEFAULT_CUE, massBps: CUE_LIMITS.maxMassBps },
    })
    expect(params).toEqual(DEFAULT_CUE)
  })

  test('cosmético NÃO influencia a física', () => {
    // A garantia que permite vender skin exclusiva sem vender vantagem.
    const rodar = (cosmetic: { name: string; skin: string; trail?: string }) => {
      const nft = { ...nftBase, cosmetic }
      const estado = rackBalls()
      return applyShot(estado, {
        intent: { angle: graus(15), power: F.from(0.8), spin: { x: F.from(0.5), y: F.from(0.5) } },
        cue: paramsFromNft(nft),
        isBreak: true,
      }).stateHash
    }

    expect(rodar({ name: 'Martelo', skin: 'ebano' })).toBe(
      rodar({ name: 'Lendário Supremo', skin: 'diamante', trail: 'fogo' }),
    )
  })

  test('serial e slot de mint não influenciam a física', () => {
    const rodar = (serial: number, mintedAtSlot: number) => {
      const nft: CueNft = { ...nftBase, serial, mintedAtSlot }
      const estado = rackBalls()
      return applyShot(estado, {
        intent: { angle: 0, power: F.from(0.7) },
        cue: paramsFromNft(nft),
      }).stateHash
    }
    expect(rodar(1, 1)).toBe(rodar(9_999, 999_999_999))
  })

  test('dois NFTs com os mesmos parâmetros jogam igual', () => {
    const rodar = (mint: string) => {
      const nft: CueNft = { ...nftBase, mint }
      const estado = rackBalls()
      return applyShot(estado, {
        intent: { angle: graus(33), power: F.from(0.9) },
        cue: paramsFromNft(nft),
      }).stateHash
    }
    expect(rodar('AAA')).toBe(rodar('BBB'))
  })
})
