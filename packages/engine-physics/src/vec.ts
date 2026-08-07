import * as F from './fixed'
import type { Fixed } from './fixed'

/**
 * Vetor 2D em ponto fixo.
 *
 * Mutável de propósito. A simulação roda milhares de passos por tacada e
 * alocar dois objetos por bola por passo geraria pressão de GC — e pausas de
 * GC, embora não quebrem o determinismo, atrapalham a animação no cliente.
 * As funções vêm em dois sabores: as que retornam vetor novo (para clareza) e
 * as terminadas em `Into` (para o laço quente).
 */
export type Vec = { x: Fixed; y: Fixed }

export const vec = (x: Fixed = 0, y: Fixed = 0): Vec => ({ x, y })

export const fromNumbers = (x: number, y: number): Vec => ({ x: F.from(x), y: F.from(y) })

export const clone = (v: Vec): Vec => ({ x: v.x, y: v.y })

export const set = (destino: Vec, x: Fixed, y: Fixed): Vec => {
  destino.x = x
  destino.y = y
  return destino
}

export const copy = (destino: Vec, origem: Vec): Vec => set(destino, origem.x, origem.y)

export const isZero = (v: Vec): boolean => v.x === 0 && v.y === 0

export const equals = (a: Vec, b: Vec): boolean => a.x === b.x && a.y === b.y

// ------------------------------------------------------------- operações

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })

export const addInto = (destino: Vec, a: Vec, b: Vec): Vec => set(destino, a.x + b.x, a.y + b.y)

export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })

export const subInto = (destino: Vec, a: Vec, b: Vec): Vec => set(destino, a.x - b.x, a.y - b.y)

export const scale = (v: Vec, k: Fixed): Vec => ({ x: F.mul(v.x, k), y: F.mul(v.y, k) })

export const scaleInto = (destino: Vec, v: Vec, k: Fixed): Vec =>
  set(destino, F.mul(v.x, k), F.mul(v.y, k))

/** `destino += v * k`. Passo de integração mais comum do laço. */
export const addScaledInto = (destino: Vec, v: Vec, k: Fixed): Vec =>
  set(destino, destino.x + F.mul(v.x, k), destino.y + F.mul(v.y, k))

export const neg = (v: Vec): Vec => ({ x: -v.x, y: -v.y })

export const dot = (a: Vec, b: Vec): Fixed => F.mul(a.x, b.x) + F.mul(a.y, b.y)

/** Produto vetorial 2D (escalar). Sinal indica de que lado b está de a. */
export const cross = (a: Vec, b: Vec): Fixed => F.mul(a.x, b.y) - F.mul(a.y, b.x)

/** Perpendicular no sentido anti-horário. */
export const perp = (v: Vec): Vec => ({ x: -v.y, y: v.x })

export const lengthSq = (v: Vec): Fixed => F.sqr(v.x) + F.sqr(v.y)

export const length = (v: Vec): Fixed => F.sqrt(lengthSq(v))

export const distanceSq = (a: Vec, b: Vec): Fixed => F.sqr(a.x - b.x) + F.sqr(a.y - b.y)

export const distance = (a: Vec, b: Vec): Fixed => F.sqrt(distanceSq(a, b))

/**
 * Normaliza. Vetor nulo continua nulo em vez de virar NaN — direção
 * indefinida é situação normal (bola parada), não erro.
 */
export function normalize(v: Vec): Vec {
  const comprimento = length(v)
  if (comprimento === 0) return vec(0, 0)
  return { x: F.div(v.x, comprimento), y: F.div(v.y, comprimento) }
}

export function normalizeInto(destino: Vec, v: Vec): Vec {
  const comprimento = length(v)
  if (comprimento === 0) return set(destino, 0, 0)
  return set(destino, F.div(v.x, comprimento), F.div(v.y, comprimento))
}

/** Vetor unitário na direção do ângulo. */
export const fromAngle = (angulo: Fixed): Vec => ({ x: F.cos(angulo), y: F.sin(angulo) })

/**
 * Reflete `v` em torno da normal `n`, que deve ser unitária.
 *
 * `v - 2(v·n)n`. Usado na colisão com a tabela.
 */
export function reflect(v: Vec, n: Vec): Vec {
  const doisVezesProjecao = F.mul(dot(v, n), F.fromInt(2))
  return {
    x: v.x - F.mul(doisVezesProjecao, n.x),
    y: v.y - F.mul(doisVezesProjecao, n.y),
  }
}

/** Valida a invariante de faixa nas duas componentes. Só para testes. */
export function check(v: Vec): Vec {
  F.check(v.x)
  F.check(v.y)
  return v
}
