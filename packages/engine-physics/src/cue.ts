import * as F from './fixed'
import type { Fixed } from './fixed'
import * as T from './table'

/**
 * Tacos.
 *
 * Separado em duas camadas de propósito:
 *
 *   `CueParams`  — o que a FÍSICA lê. Entra no replay, é limitado no código.
 *   `CueNft`     — o item inteiro: parâmetros + procedência + cosmético.
 *
 * A separação importa porque cosmético NÃO pode influenciar a partida. Skin,
 * cor e rastro podem ser tão exclusivos quanto se queira: é ali que a
 * monetização é segura, porque não muda quem ganha.
 *
 * Quatro regras que valem para os parâmetros de física:
 *
 * 1. FAZEM PARTE DO REPLAY. Reproduzir a partida exige saber com que taco cada
 *    tacada foi dada.
 * 2. O SERVIDOR DERIVA do NFT que a carteira possui. O cliente nunca informa,
 *    senão qualquer um se declara dono de taco lendário.
 * 3. SÃO LIMITADOS NO CÓDIGO, com teto não configurável.
 * 4. TÊM TRADE-OFF. Peso alto engrossa a mira; efeito alto custa peso. Nenhum
 *    taco domina os outros — sem isso, uma mesa com dinheiro vira "quem pagou
 *    mais ganha", e aí não é item, é vitória à venda.
 *
 * SOBRE PRECISÃO SEM SORTEIO: a mira é quantizada, não perturbada. Um taco
 * melhor aponta em mais direções distintas; nenhum introduz erro aleatório.
 * Com RNG o replay deixaria de reproduzir a partida e a auditoria pública
 * morreria junto.
 */

export type CueParams = {
  /** Peso. Mais pesado transfere mais energia — e engrossa a mira. */
  massBps: number
  /** Autoridade de efeito: quanto de spin o taco imprime. */
  spinBps: number
  /** Finura da mira. MENOR é melhor. */
  aimBps: number
  /**
   * Aderência do couro: quanto do efeito sobrevive ao rolamento.
   * Maior segura o efeito por mais tempo depois da tacada.
   */
  clothGripBps: number
  /**
   * Potência extra na QUEBRA apenas.
   *
   * Isola o taco de quebra do taco de jogo — distinção real na sinuca, e razão
   * concreta para alguém querer mais de um em vez de só o "melhor".
   */
  breakBonusBps: number
}

export const DEFAULT_CUE: CueParams = {
  massBps: 10_000,
  spinBps: 10_000,
  aimBps: 10_000,
  clothGripBps: 10_000,
  breakBonusBps: 10_000,
}

/**
 * Faixas permitidas. Estreitas de propósito: o melhor taco bate ~15% mais
 * forte e mira ~2× mais fino. Perceptível, incapaz de decidir a partida.
 */
export const CUE_LIMITS = {
  minMassBps: 8_500,
  maxMassBps: 11_500,
  minSpinBps: 8_000,
  maxSpinBps: 13_000,
  /** Melhor mira: grade 2× mais fina que a padrão. */
  minAimBps: 5_000,
  /** Pior mira: grade 2× mais grossa. */
  maxAimBps: 20_000,
  minClothGripBps: 9_000,
  maxClothGripBps: 11_000,
  minBreakBonusBps: 10_000,
  maxBreakBonusBps: 11_500,
} as const

/** Grade de mira do taco padrão: meio grau. */
export const BASE_AIM_STEP: Fixed = F.from((0.5 * Math.PI) / 180)

// ------------------------------------------------------------------ mira

/**
 * Peso puxa a mira junto.
 *
 * É o que torna o peso um trade-off em vez de upgrade puro: cada 1% de peso
 * acima do padrão engrossa a grade em 1%.
 */
export function effectiveAimBps(cue: CueParams): number {
  const penalidadeDePeso = cue.massBps - 10_000
  return Math.max(
    CUE_LIMITS.minAimBps,
    Math.min(CUE_LIMITS.maxAimBps, cue.aimBps + penalidadeDePeso),
  )
}

/** Tamanho do passo da grade, em radianos de ponto fixo. */
export function aimStepFor(cue: CueParams): Fixed {
  return Math.max(1, Math.floor((BASE_AIM_STEP * effectiveAimBps(cue)) / 10_000))
}

/** Quantas direções distintas o taco consegue apontar. */
export function aimSlotsFor(cue: CueParams): number {
  return Math.max(1, Math.round(F.TAU / aimStepFor(cue)))
}

/**
 * Encaixa o ângulo na grade do taco.
 *
 * Divide a CIRCUNFERÊNCIA em casas iguais, em vez de andar de passo em passo.
 * Andar em passos deixaria resto na volta completa — uma "costura" onde
 * ângulos vizinhos saltam mais que meio passo.
 */
export function quantizeAim(angle: Fixed, cue: CueParams): Fixed {
  const casas = aimSlotsFor(cue)
  const indice = Math.round((F.normalizeAngle(angle) * casas) / F.TAU) % casas
  return Math.floor((indice * F.TAU) / casas)
}

// -------------------------------------------------------------- derivados

/** Taxa de decaimento do efeito, já com a aderência do taco. */
export function spinDecayFor(cue: CueParams): Fixed {
  const ajustado = Math.floor((T.SPIN_DECAY * cue.clothGripBps) / 10_000)
  // Nunca ≥ 1: efeito que não decai duraria a tacada inteira e a simulação
  // pararia de convergir.
  return Math.max(0, Math.min(F.ONE - 1, ajustado))
}

/** Multiplicador de velocidade da tacada, considerando se é a quebra. */
export function shotPowerBpsFor(cue: CueParams, isBreak: boolean): number {
  if (!isBreak) return cue.massBps
  return Math.floor((cue.massBps * cue.breakBonusBps) / 10_000)
}

// ---------------------------------------------------------------- limites

/**
 * Prende os atributos na faixa válida.
 *
 * Sempre chamado antes de simular, mesmo com valores vindos do servidor: um
 * bug em outro lugar não pode virar taco com o dobro da força. Entrada
 * inválida (NaN, Infinity) cai para o PADRÃO, nunca para o teto — senão mandar
 * lixo seria recompensado.
 */
export function clampCue(cue: Partial<CueParams>): CueParams {
  const prender = (valor: number | undefined, minimo: number, maximo: number): number => {
    if (valor === undefined || !Number.isFinite(valor)) return 10_000
    return Math.max(minimo, Math.min(maximo, Math.round(valor)))
  }

  return {
    massBps: prender(cue.massBps, CUE_LIMITS.minMassBps, CUE_LIMITS.maxMassBps),
    spinBps: prender(cue.spinBps, CUE_LIMITS.minSpinBps, CUE_LIMITS.maxSpinBps),
    aimBps: prender(cue.aimBps, CUE_LIMITS.minAimBps, CUE_LIMITS.maxAimBps),
    clothGripBps: prender(
      cue.clothGripBps,
      CUE_LIMITS.minClothGripBps,
      CUE_LIMITS.maxClothGripBps,
    ),
    breakBonusBps: prender(
      cue.breakBonusBps,
      CUE_LIMITS.minBreakBonusBps,
      CUE_LIMITS.maxBreakBonusBps,
    ),
  }
}

/** Converte basis points para multiplicador em ponto fixo. */
export function bpsToFixed(bps: number): Fixed {
  return Math.floor((bps * F.ONE) / 10_000)
}

export const isDefaultCue = (cue: CueParams): boolean =>
  (Object.keys(DEFAULT_CUE) as Array<keyof CueParams>).every((k) => cue[k] === DEFAULT_CUE[k])

// -------------------------------------------------------------------- NFT

/**
 * Versão do esquema de atributos.
 *
 * Sem isto, mudar a física quebraria todo replay antigo: uma partida de ontem
 * seria reproduzida com regras de hoje e daria outro resultado. Cada replay
 * guarda a versão, e o verificador usa a interpretação daquela época.
 */
export const CUE_SCHEMA_VERSION = 1

/**
 * O taco como item.
 *
 * `cosmetic` fica FORA de `params` de propósito: nada aqui pode influenciar a
 * física, e existe teste garantindo que trocar a skin não muda o resultado de
 * uma tacada.
 */
export type CueNft = {
  schemaVersion: number
  /** Endereço do mint na Solana. */
  mint: string
  /** Número de série dentro da coleção. Desempate e procedência. */
  serial: number
  /** Slot em que foi mintado. Sem `Date`: a chain é o relógio. */
  mintedAtSlot: number
  params: CueParams
  cosmetic: CueCosmetic
}

/** Puramente visual. Não entra na simulação nem no hash do replay. */
export type CueCosmetic = {
  name: string
  skin: string
  trail?: string
}

/**
 * Extrai os parâmetros de física de um NFT, já limitados.
 *
 * Ponto único de entrada: é aqui que um NFT com metadados adulterados vira
 * atributos seguros. Esquema desconhecido cai para o taco padrão em vez de
 * confiar em campos que talvez signifiquem outra coisa.
 */
export function paramsFromNft(nft: Pick<CueNft, 'schemaVersion' | 'params'>): CueParams {
  if (nft.schemaVersion !== CUE_SCHEMA_VERSION) return DEFAULT_CUE
  return clampCue(nft.params)
}

/**
 * Arquétipos de exemplo — ponto de partida para os atributos da coleção.
 *
 * Nenhum domina os outros. Essa é a propriedade a preservar quando novos tacos
 * forem desenhados, e existe teste que percorre todos os pares para garantir.
 */
export const CUE_ARCHETYPES = {
  padrao: DEFAULT_CUE,
  /** Quebra bem, mira grosso. */
  pesado: {
    massBps: 11_500,
    spinBps: 9_000,
    aimBps: 10_000,
    clothGripBps: 9_500,
    breakBonusBps: 11_500,
  },
  /** Mira fino, bate fraco. */
  preciso: {
    massBps: 8_500,
    spinBps: 10_000,
    aimBps: 6_000,
    clothGripBps: 10_000,
    breakBonusBps: 10_000,
  },
  /** Controle de branca, potência mediana. */
  efeito: {
    massBps: 9_500,
    spinBps: 13_000,
    aimBps: 9_000,
    clothGripBps: 11_000,
    breakBonusBps: 10_000,
  },
} as const satisfies Record<string, CueParams>
