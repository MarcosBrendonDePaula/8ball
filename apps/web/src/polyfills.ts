import { Buffer } from 'buffer'

/**
 * `@solana/web3.js` v1 assume o `Buffer` do Node — sem isto, montar uma
 * transação quebra em runtime no navegador (o typecheck não pega, porque os
 * tipos do Node estão no escopo do monorepo).
 *
 * Importado antes de tudo em `main.ts`.
 */
if (!('Buffer' in globalThis)) {
  ;(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer
}

// Algumas dependências transitivas ainda esperam `global`.
if (!('global' in globalThis)) {
  ;(globalThis as { global?: typeof globalThis }).global = globalThis
}
