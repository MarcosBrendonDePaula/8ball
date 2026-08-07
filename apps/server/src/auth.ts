import { randomUUID } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { NONCE_TTL_MS, SESSION_TTL_MS } from '@/config'
import { buildLoginMessage } from '@zinc-pool/protocol'

/**
 * Autenticação por assinatura de mensagem.
 *
 * O nonce é emitido PELO SERVIDOR, tem uso único e expira. É isso que impede
 * replay: uma assinatura capturada não serve duas vezes, e o cliente não pode
 * escolher o que assina.
 */

type NonceEntry = { address: string; expiresAt: number }

const nonces = new Map<string, NonceEntry>()

export function issueNonce(address: string, now = Date.now()): string {
  assertValidAddress(address)
  const nonce = randomUUID()
  nonces.set(nonce, { address, expiresAt: now + NONCE_TTL_MS })
  return nonce
}

export class AuthError extends Error {
  constructor(
    readonly code: 'nonce_invalid' | 'signature_invalid' | 'bad_request',
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export function assertValidAddress(address: string): void {
  try {
    const key = new PublicKey(address)
    // Endereço fora da curva ed25519 é PDA — não tem chave privada e não pode
    // assinar. Rejeitar aqui evita um caminho de verificação que nunca passaria.
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('off curve')
  } catch {
    throw new AuthError('bad_request', 'Endereço de carteira inválido.')
  }
}

/**
 * Verifica o login e consome o nonce.
 *
 * O servidor reconstrói a mensagem esperada em vez de confiar na que o cliente
 * mandou — senão o cliente poderia fazer o usuário assinar qualquer coisa e
 * apresentar aqui.
 */
export function verifyLogin(
  params: { address: string; nonce: string; message: string; signature: string },
  host: string,
  now = Date.now(),
): string {
  assertValidAddress(params.address)

  const entry = nonces.get(params.nonce)
  if (!entry) throw new AuthError('nonce_invalid', 'Nonce desconhecido ou já usado.')

  // Consumido de qualquer forma: mesmo que a verificação falhe, este nonce
  // não pode ser tentado de novo.
  nonces.delete(params.nonce)

  if (entry.expiresAt <= now) throw new AuthError('nonce_invalid', 'Nonce expirado.')
  if (entry.address !== params.address) {
    throw new AuthError('nonce_invalid', 'Nonce emitido para outra carteira.')
  }

  const expected = buildLoginMessage(host, params.address, params.nonce)
  if (params.message !== expected) {
    throw new AuthError('signature_invalid', 'Mensagem assinada não confere.')
  }

  let signature: Uint8Array
  try {
    signature = bs58.decode(params.signature)
  } catch {
    throw new AuthError('signature_invalid', 'Assinatura mal formada.')
  }

  const ok = ed25519.verify(
    signature,
    new TextEncoder().encode(expected),
    new PublicKey(params.address).toBytes(),
  )
  if (!ok) throw new AuthError('signature_invalid', 'Assinatura inválida.')

  return params.address
}

// ------------------------------------------------------------ sessões

/**
 * Token de sessão emitido após um login válido.
 *
 * Sem isso, como o nonce é de uso único, o usuário teria que aprovar um popup
 * da carteira a cada refresh. O token é opaco, fica em memória e expira.
 *
 * Nota para o M4: em memória significa que reiniciar o servidor desloga todo
 * mundo. Aceitável agora; quando houver mais de um processo, isso vai para o
 * Redis junto com o resto do estado de sessão.
 */
const sessions = new Map<string, { address: string; expiresAt: number }>()

export function issueSession(address: string, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomUUID() + randomUUID()
  const expiresAt = now + SESSION_TTL_MS
  sessions.set(token, { address, expiresAt })
  return { token, expiresAt }
}

export function resumeSession(token: string, now = Date.now()): string {
  const entry = sessions.get(token)
  if (!entry) throw new AuthError('nonce_invalid', 'Sessão desconhecida.')
  if (entry.expiresAt <= now) {
    sessions.delete(token)
    throw new AuthError('nonce_invalid', 'Sessão expirada.')
  }
  return entry.address
}

export function sweepNonces(now = Date.now()): void {
  for (const [nonce, entry] of nonces) {
    if (entry.expiresAt <= now) nonces.delete(nonce)
  }
  for (const [token, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(token)
  }
}

/** Só para testes. */
export function _resetNonces(): void {
  nonces.clear()
}
