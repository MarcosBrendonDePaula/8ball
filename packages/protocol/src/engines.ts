/**
 * Quais motores de navegador podem entrar numa mesa apostada.
 *
 * A premissa do sistema é que a mesma tacada produz a mesma mesa em qualquer
 * lugar. Ela não é um artigo de fé: é conferida por `bun run determinism`, que
 * roda 36 partidas de referência em cada navegador e compara com os hashes
 * gravados — os mesmos que o servidor produz e que estão ancorados on-chain.
 *
 * Onde essa conferência não foi feita, o jogo com dinheiro fica fechado.
 *
 * Não é desconfiança do WebKit. É que uma divergência de física não aparece
 * como erro: aparece como o replay apontando OUTRO VENCEDOR na hora de
 * auditar, com o pote já pago. Um bloqueio é reversível; um pagamento errado
 * defendido por uma auditoria que discorda de si mesma, não.
 *
 * Este módulo é compartilhado de propósito. Se o cliente e o servidor tivessem
 * cada um a sua cópia da detecção, elas divergiriam — e a que decide é a do
 * servidor, então o jogador veria a mesa liberada e o depósito ser recusado.
 */

/** Motores cujo determinismo já foi conferido, com a versão em que passou. */
export const MOTORES_VERIFICADOS = [
  { nome: 'Gecko', navegador: 'Firefox', versao: '153' },
  { nome: 'Blink', navegador: 'Chrome', versao: '150' },
] as const

export type EngineVerdict =
  | { permitido: true }
  | { permitido: false; motor: string; motivo: string }

/**
 * O motor deste `user-agent` está liberado para apostar?
 *
 * A detecção olha o MOTOR, não o navegador. No iOS, todo navegador é WebKit por
 * imposição da Apple — Chrome e Firefox no iPhone rodam o mesmo motor que o
 * Safari, e liberá-los pelo nome deixaria entrar exatamente o que se quer
 * barrar.
 */
export function checarMotor(userAgent: string): EngineVerdict {
  const ua = userAgent ?? ''

  // A ordem importa. Todo Chrome se anuncia como "Safari" por herança
  // histórica do WebKit, então testar "Safari" primeiro barraria o Chrome.
  const ehBlink = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPiOS|CriOS|FxiOS|EdgiOS/.test(ua)
  const ehGecko = /Gecko\/\d|Firefox\//.test(ua) && !/FxiOS/.test(ua)

  if (ehBlink || ehGecko) return { permitido: true }

  // Tudo que sobra e cheira a WebKit: Safari de macOS/iOS, e os navegadores de
  // iOS que se disfarçam de outra coisa (CriOS é o Chrome do iPhone).
  if (/AppleWebKit|Safari|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) {
    return {
      permitido: false,
      motor: 'WebKit',
      motivo:
        'O determinismo da física ainda não foi verificado no WebKit (Safari, e todo ' +
        'navegador no iPhone). Enquanto não for, partidas valendo SOL ficam fechadas — ' +
        'jogar sem aposta continua liberado.',
    }
  }

  /*
   * Desconhecido é BARRADO, não liberado.
   *
   * O contrário seria uma trava que qualquer `user-agent` inventado abre — e um
   * motor que ninguém conhece é exatamente o caso em que a divergência é mais
   * provável, não menos.
   */
  return {
    permitido: false,
    motor: 'desconhecido',
    motivo:
      'Não foi possível identificar o motor deste navegador, e só liberamos os que ' +
      'passaram na verificação de determinismo. Use Firefox ou Chrome para apostar.',
  }
}
