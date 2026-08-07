/**
 * Relógio da cena, no espírito do `Time` da Unity.
 *
 * A distinção que importa: `deltaTime` varia com o quadro, `fixedDeltaTime` é
 * constante. A física SÓ pode andar em passos fixos — se ela dependesse da
 * taxa de quadros, um monitor de 144Hz e um de 60Hz produziriam partidas
 * diferentes, e o replay deixaria de reproduzir a partida.
 */
export class Time {
  /** Segundos desde o quadro anterior. Para animação e interpolação. */
  deltaTime = 0

  /** Passo fixo da física. Nunca varia. */
  readonly fixedDeltaTime: number

  /** Segundos desde o início da cena. */
  elapsed = 0

  /** Quantos passos fixos já rodaram. */
  fixedSteps = 0

  /**
   * Fração do próximo passo fixo já decorrida, de 0 a 1.
   *
   * Usada para interpolar o desenho entre dois estados de física e evitar o
   * tremor que apareceria ao desenhar sempre o último passo.
   */
  alpha = 0

  /** Tempo acumulado ainda não consumido por um passo fixo. */
  #accumulator = 0

  /**
   * Teto de passos por quadro.
   *
   * Sem ele, uma aba que ficou em segundo plano volta com segundos de atraso
   * acumulado e a simulação tenta recuperar tudo num quadro só — travando a
   * página. Melhor perder tempo simulado que congelar.
   */
  readonly maxStepsPerFrame: number

  constructor(fixedDeltaTime: number, maxStepsPerFrame = 8) {
    this.fixedDeltaTime = fixedDeltaTime
    this.maxStepsPerFrame = maxStepsPerFrame
  }

  /**
   * Consome o tempo do quadro e devolve quantos passos fixos devem rodar.
   *
   * `rawDelta` já vem limitado pelo laço; aqui só se distribui.
   */
  advance(rawDelta: number): number {
    this.deltaTime = rawDelta
    this.elapsed += rawDelta
    this.#accumulator += rawDelta

    let passos = 0
    while (this.#accumulator >= this.fixedDeltaTime && passos < this.maxStepsPerFrame) {
      this.#accumulator -= this.fixedDeltaTime
      passos++
    }

    // Descarta o excedente em vez de guardar dívida impagável.
    if (passos === this.maxStepsPerFrame) this.#accumulator = 0

    this.fixedSteps += passos
    this.alpha = this.#accumulator / this.fixedDeltaTime

    return passos
  }

  reset(): void {
    this.deltaTime = 0
    this.elapsed = 0
    this.fixedSteps = 0
    this.alpha = 0
    this.#accumulator = 0
  }
}
