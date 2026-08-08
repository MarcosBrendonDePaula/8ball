import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * O arquivo virou parte da cadeia de prova.
 *
 * Enquanto o replay morava na conta, servir os bytes era problema da Solana.
 * Agora é nosso, e um erro aqui não é "um arquivo que não abriu": é uma partida
 * cujo compromisso on-chain existe e cujos bytes ninguém consegue conferir.
 */

const RAIZ = mkdtempSync(join(tmpdir(), 'zinc-replays-'))

let guardarReplay: (id: string, b: Uint8Array) => void
let lerReplay: (id: string) => Uint8Array | null

beforeAll(async () => {
  process.env.REPLAY_DIR = RAIZ
  const mod = await import('@/archive')
  guardarReplay = mod.guardarReplay
  lerReplay = mod.lerReplay
})

afterAll(() => rmSync(RAIZ, { recursive: true, force: true }))

const ID = 'a'.repeat(32)

describe('ida e volta', () => {
  test('os bytes voltam idênticos', () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) % 256)
    guardarReplay(ID, bytes)

    // Idênticos, não "equivalentes": um único byte diferente muda o SHA-256 e
    // a partida inteira passa a constar como divergente.
    expect(Array.from(lerReplay(ID)!)).toEqual(Array.from(bytes))
  })

  test('partida nunca arquivada devolve nulo, não lixo', () => {
    expect(lerReplay('b'.repeat(32))).toBeNull()
  })
})

describe('o nome vira caminho de arquivo', () => {
  /*
   * O `matchId` chega da rede e é concatenado num caminho. Sem validação, um id
   * com `..` leria ou escreveria fora do diretório — e a rota que serve replays
   * é pública e sem autenticação, de propósito.
   */
  const HOSTIS = [
    '../../etc/passwd',
    '..\\..\\windows\\system32\\config\\sam',
    'a'.repeat(31) + '/',
    'A'.repeat(32), // maiúsculo não é hex nosso
    '',
  ]

  for (const id of HOSTIS) {
    test(`recusa gravar em ${JSON.stringify(id)}`, () => {
      expect(() => guardarReplay(id, new Uint8Array(4))).toThrow()
    })

    test(`recusa ler ${JSON.stringify(id)}`, () => {
      expect(lerReplay(id)).toBeNull()
    })
  }

  test('não alcança um arquivo real fora do diretório', () => {
    const fora = join(RAIZ, '..', 'segredo.bin')
    writeFileSync(fora, new Uint8Array([1, 2, 3]))
    try {
      expect(lerReplay('../segredo')).toBeNull()
    } finally {
      rmSync(fora, { force: true })
    }
  })
})
