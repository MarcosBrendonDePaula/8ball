/**
 * Engine de física determinística do 8-Ball.
 *
 * `fixed`, `vec` e `table` saem como namespaces porque têm nomes em comum
 * (`add`, `sub`, `check`) — achatar tudo criaria ambiguidade silenciosa, que é
 * exatamente o tipo de erro que esta engine existe para não ter.
 */

export * as fixed from './fixed'
export * as vec from './vec'
export * as table from './table'

/** Identidade da física — precisa estar acessível sem o namespace. */
export { ENGINE_VERSION, PHYSICS_DIGEST } from './table'

export type { Fixed } from './fixed'
export type { Vec } from './vec'

export * from './cue'
export * from './hash'
export * from './replay'
export * from './sim'
export * from './fixtures'
