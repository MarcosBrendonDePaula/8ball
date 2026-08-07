/**
 * Regras dos jogos de mesa.
 *
 * Duas modalidades, cada uma autocontida na própria pasta:
 *
 *   eightball/  8-Ball americano (WPA)
 *   sinuca/     sinuca brasileira (CBBS)
 *
 * Quem consome deve preferir `getGameMode()` a importar uma modalidade
 * direto — assim o código não precisa mudar quando entrar uma terceira.
 * Os namespaces abaixo existem para quem precisa dos tipos concretos.
 */

export * from './mode'
export * from './bridge'

export * as eightball from './eightball'
export * as sinuca from './sinuca'
