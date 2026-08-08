import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Onde os replays passam a morar.
 *
 * Até a v2 do registro os bytes iam para a blockchain e a permanência era
 * problema dela. Agora só o hash vai — e o hash sozinho não conta a partida: ele
 * prova que UNS bytes são os certos, mas alguém precisa tê-los.
 *
 * Esse alguém é, na ordem:
 *
 *   1. os DOIS jogadores, que recebem o replay inteiro no `match.end` e podem
 *      guardá-lo. É a cópia que importa: o perdedor não depende da nossa boa
 *      vontade para contestar o resultado.
 *   2. este arquivo, que serve quem chegar depois — o histórico, um curioso,
 *      um auditor.
 *
 * Perder este diretório NÃO destrói a auditoria: o hash na chain continua lá, e
 * qualquer cópia dos bytes que apareça pode ser conferida contra ele. Perder o
 * diretório destrói a CONVENIÊNCIA, não a prova.
 *
 * É essa distinção que torna a economia honesta: trocamos disponibilidade
 * garantida por protocolo por disponibilidade operacional, e ficamos com a
 * integridade intacta.
 */

const RAIZ = process.env.REPLAY_DIR ?? join(process.cwd(), 'data', 'replays')

/** Só hex de 32 caracteres — o nome vira caminho de arquivo. */
const idValido = (matchId: string): boolean => /^[0-9a-f]{32}$/.test(matchId)

const caminho = (matchId: string): string => join(RAIZ, `${matchId}.bin`)

export function guardarReplay(matchId: string, bytes: Uint8Array): void {
  if (!idValido(matchId)) throw new Error(`match_id inválido para arquivo: ${matchId}`)
  mkdirSync(RAIZ, { recursive: true })
  // Grava ANTES de liquidar, sempre. Liquidar primeiro abriria a janela em que
  // a chain tem o compromisso e ninguém tem os bytes — um registro que ninguém
  // consegue verificar é pior que registro nenhum, porque parece prova.
  writeFileSync(caminho(matchId), bytes)
}

export function lerReplay(matchId: string): Uint8Array | null {
  if (!idValido(matchId)) return null
  const p = caminho(matchId)
  if (!existsSync(p)) return null
  return new Uint8Array(readFileSync(p))
}
