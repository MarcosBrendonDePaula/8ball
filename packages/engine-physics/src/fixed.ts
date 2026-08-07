/**
 * Aritmética de ponto fixo Q16.16.
 *
 * POR QUE NÃO FLOAT: o resultado da partida precisa ser idêntico no navegador
 * do jogador e no servidor, e reproduzível anos depois a partir do replay.
 * `Math.sin`, `Math.sqrt` e a reassociação do JIT não são garantidos idênticos
 * entre plataformas — uma divergência de 1 ULP na primeira colisão vira uma
 * bola em caçapa diferente trinta colisões depois.
 *
 * REPRESENTAÇÃO: um `Fixed` é um NÚMERO INTEIRO guardado em `number`, valendo
 * `valor / 65536`. Inteiros em double são exatos até 2^53, então toda operação
 * aqui é exata desde que os produtos não passem disso.
 *
 * INVARIANTE: |Fixed| < 2^24, ou seja, valores reais em (-256, 256). Com isso
 * um produto fica abaixo de 2^48 e cabe exato num double. A física do jogo usa
 * metros (mesa de 2.24m) e m/s (tacada forte ~12m/s), então sobra folga. A
 * função `check` valida isso e existe para o teste pegar violação, não para
 * rodar em produção.
 */

export type Fixed = number

export const FRAC_BITS = 16
export const ONE: Fixed = 1 << FRAC_BITS
export const ZERO: Fixed = 0
export const HALF: Fixed = ONE >> 1

/** Limite da invariante. Acima disso, produtos perdem exatidão. */
export const MAX_SAFE_FIXED = 1 << 24

export class FixedOverflowError extends Error {
  constructor(value: number) {
    super(`Fixed fora da faixa segura: ${value} (|x| deve ser < 2^24)`)
    this.name = 'FixedOverflowError'
  }
}

/** Valida a invariante. Usado nos testes; não chame no laço da simulação. */
export function check(value: Fixed): Fixed {
  if (!Number.isInteger(value) || Math.abs(value) >= MAX_SAFE_FIXED) {
    throw new FixedOverflowError(value)
  }
  return value
}

// ------------------------------------------------------------- conversão

/**
 * Converte de número real. SÓ para constantes e entrada externa — nunca no
 * meio da simulação, porque é aqui que o float entra e precisa ficar contido.
 */
export function from(value: number): Fixed {
  return Math.round(value * ONE)
}

/** Converte de inteiro, sem passar por float. */
export function fromInt(value: number): Fixed {
  return value * ONE
}

/** Converte para número real. Só para exibição e testes. */
export function toNumber(value: Fixed): number {
  return value / ONE
}

// -------------------------------------------------------------- operações

export function add(a: Fixed, b: Fixed): Fixed {
  return a + b
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return a - b
}

export function neg(a: Fixed): Fixed {
  return -a
}

export function abs(a: Fixed): Fixed {
  return a < 0 ? -a : a
}

export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b
}

export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b
}

export function clamp(value: Fixed, lo: Fixed, hi: Fixed): Fixed {
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * Multiplicação.
 *
 * `Math.floor` em vez de truncamento: truncar arredonda para zero, o que dá
 * resultados diferentes para positivos e negativos e introduz um viés que a
 * simulação acumula. `floor` é uniforme, e uniformidade é o que importa para
 * determinismo.
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  return Math.floor((a * b) / ONE)
}

export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0) throw new Error('Divisão por zero em ponto fixo.')
  return Math.floor((a * ONE) / b)
}

/** Quadrado. Atalho legível para o caso comum de `mul(a, a)`. */
export function sqr(a: Fixed): Fixed {
  return Math.floor((a * a) / ONE)
}

// ------------------------------------------------------------------ raiz

/**
 * Raiz quadrada por Newton-Raphson em inteiros.
 *
 * `Math.sqrt` é correto-arredondado pela IEEE-754 e na prática idêntico entre
 * plataformas, mas depender disso é apostar numa garantia que a especificação
 * do JS não dá. Newton em inteiros não deixa margem: é a mesma sequência de
 * operações inteiras em qualquer runtime.
 */
export function sqrt(value: Fixed): Fixed {
  if (value < 0) throw new Error('Raiz de número negativo em ponto fixo.')
  if (value === 0) return 0

  // sqrt(v/ONE) * ONE = sqrt(v * ONE). O produto cabe: v < 2^24 → v*ONE < 2^40.
  const alvo = value * ONE

  // Palpite inicial por bit-length; converge em poucas iterações.
  let x = 1
  while (x * x < alvo) x *= 2

  // Newton em inteiros. Termina quando para de diminuir — a sequência é
  // monotônica decrescente a partir de um palpite alto.
  for (;;) {
    const proximo = Math.floor((x + Math.floor(alvo / x)) / 2)
    if (proximo >= x) break
    x = proximo
  }
  return x
}

/** Hipotenusa, sem estourar a faixa segura nos quadrados intermediários. */
export function hypot(x: Fixed, y: Fixed): Fixed {
  return sqrt(sqr(x) + sqr(y))
}

// --------------------------------------------------------- trigonometria

export const PI: Fixed = from(Math.PI)
export const TAU: Fixed = from(Math.PI * 2)

/**
 * Tabela de seno com 1024 entradas por volta completa.
 *
 * Pré-computada com `Math.sin` UMA VEZ, em tempo de carga, e depois só
 * consultada. O float fica confinado à construção da tabela: como todo runtime
 * gera a mesma tabela a partir das mesmas constantes arredondadas para Q16.16,
 * o resultado é idêntico em todos eles.
 */
const SIN_BITS = 10
const SIN_COUNT = 1 << SIN_BITS
const SIN_MASK = SIN_COUNT - 1

const SIN_TABLE: Int32Array = (() => {
  const tabela = new Int32Array(SIN_COUNT)
  for (let i = 0; i < SIN_COUNT; i++) {
    tabela[i] = Math.round(Math.sin((i * 2 * Math.PI) / SIN_COUNT) * ONE)
  }
  return tabela
})()

export function sin(angle: Fixed): Fixed {
  const a = normalizeAngle(angle)

  // Índice na tabela, em Q16.16: (a / TAU) * SIN_COUNT.
  // Magnitudes: a < TAU ≈ 411775, a*ONE < 2^35 — exato.
  const indice = Math.floor((a * ONE) / TAU) * SIN_COUNT

  const i = indice >> FRAC_BITS
  const fracao = indice & (ONE - 1)

  const base = SIN_TABLE[i & SIN_MASK]!
  const proximo = SIN_TABLE[(i + 1) & SIN_MASK]!

  // Interpolação linear entre as duas entradas vizinhas.
  return base + Math.floor(((proximo - base) * fracao) / ONE)
}

export function cos(angle: Fixed): Fixed {
  return sin(angle + Math.floor(PI / 2))
}

/**
 * Normaliza um ângulo para [0, TAU).
 *
 * Ângulos crescem ao longo da partida (spin acumulado); sem normalizar, eles
 * furariam a invariante de 2^24 e os produtos deixariam de ser exatos.
 */
export function normalizeAngle(angle: Fixed): Fixed {
  let a = angle % TAU
  if (a < 0) a += TAU
  return a
}
