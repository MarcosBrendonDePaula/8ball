import { describe, expect, test } from 'bun:test'
import { checarMotor } from './engines'

/**
 * A detecção de motor decide quem pode apostar. Errar para o lado frouxo deixa
 * entrar um motor não verificado; errar para o lado apertado tranca um jogador
 * legítimo fora. As duas coisas custam, e por isso os `user-agent` aqui são
 * reais, copiados de navegadores de verdade.
 */

const PERMITIDOS = {
  'Firefox 153 Windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  'Firefox Android':
    'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  'Chrome 150 headless':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36',
  'Chrome macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Edge Windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Chrome Android':
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
}

const BARRADOS = {
  'Safari macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Safari iPhone':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  // No iOS a Apple obriga todo navegador a usar WebKit. "Chrome" no iPhone é
  // Safari com outra interface, e liberá-lo pelo nome deixaria entrar
  // exatamente o motor que se quer barrar.
  'Chrome iOS (CriOS)':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
  'Firefox iOS (FxiOS)':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
  'Edge iOS (EdgiOS)':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/131.0 Mobile/15E148 Safari/605.1.15',
}

describe('motores verificados entram', () => {
  for (const [nome, ua] of Object.entries(PERMITIDOS)) {
    test(nome, () => {
      expect(checarMotor(ua).permitido).toBe(true)
    })
  }
})

describe('WebKit fica de fora', () => {
  for (const [nome, ua] of Object.entries(BARRADOS)) {
    test(nome, () => {
      const v = checarMotor(ua)
      expect(v.permitido).toBe(false)
      if (!v.permitido) expect(v.motor).toBe('WebKit')
    })
  }
})

describe('o desconhecido é barrado, não liberado', () => {
  /*
   * O padrão precisa ser NEGAR.
   *
   * Uma trava que só reconhece o que quer barrar é aberta por qualquer
   * `user-agent` inventado — e um motor que ninguém conhece é justamente onde a
   * divergência é mais provável, não menos.
   */
  for (const ua of ['', 'curl/8.5.0', 'bot', 'Mozilla/5.0 (QtWebEngine)']) {
    test(JSON.stringify(ua), () => {
      expect(checarMotor(ua).permitido).toBe(false)
    })
  }

  test('user-agent ausente não estoura', () => {
    expect(checarMotor(undefined as unknown as string).permitido).toBe(false)
  })
})

describe('o motivo é dito ao jogador', () => {
  test('explica o que está fechado e o que continua aberto', () => {
    const v = checarMotor(BARRADOS['Safari macOS'])
    expect(v.permitido).toBe(false)
    if (!v.permitido) {
      // Um bloqueio sem explicação vira "o site não funciona". O jogador tem de
      // saber que o problema é o navegador e que jogar sem apostar continua
      // disponível.
      expect(v.motivo).toContain('sem aposta')
      expect(v.motivo).toMatch(/Safari|WebKit/)
    }
  })
})
