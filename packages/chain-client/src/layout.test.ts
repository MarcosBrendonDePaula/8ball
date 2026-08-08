import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORD_LEN, GAME_ACCOUNT_SIZE, rentLamports, recordRentLamports } from './index'

/**
 * O TypeScript e o Rust concordam sobre o tamanho das contas?
 *
 * Esta pergunta já foi respondida errada em produção. `RECORD_LEN` estava 203
 * contra os 204 reais, e nada quebrou: o contrato usa a PRÓPRIA constante, então
 * a liquidação funcionava normalmente. O que mentia era só a estimativa de
 * aluguel — por 6960 lamports — e a consulta por `dataSize`, que não achava
 * registro nenhum e reportava "zero partidas liquidadas".
 *
 * Uma conta errada que não quebra nada é a que sobrevive mais tempo. Por isso o
 * teste lê o NÚMERO DA FONTE, em vez de repetir aqui um valor digitado à mão —
 * repetir só moveria o erro de lugar.
 */

const LIB_RS = join(import.meta.dir, '..', '..', '..', 'programs', 'pool_escrow', 'src', 'lib.rs')
const fonte = readFileSync(LIB_RS, 'utf8')

/**
 * Extrai `pub const <nome>: usize = <expressão>;` e resolve a aritmética.
 *
 * As expressões são somas e produtos de literais — `8 + 16 + 32 * 2 + …` —, que
 * é exatamente o que este avaliador aceita. Qualquer coisa fora disso faz o
 * teste falhar em vez de adivinhar.
 */
function constanteRust(tipo: string, nome: string): number {
  // Escopado ao `impl` do tipo. Sem isso o regex casa com a primeira constante
  // de mesmo nome no arquivo — `Vault::LEN` vinha antes e o teste comparava
  // 204 com 34, falhando pelo motivo errado.
  const bloco = new RegExp(`impl ${tipo} \\{([\\s\\S]*?)\\n\\}`).exec(fonte)
  if (!bloco) throw new Error(`impl ${tipo} não encontrado em lib.rs.`)

  const m = new RegExp(`pub const ${nome}: usize = ([^;]+);`).exec(bloco[1]!)
  if (!m) throw new Error(`Constante ${tipo}::${nome} não encontrada.`)

  const expr = m[1]!
    .replace(/\/\/[^\n]*/g, '') // comentários de linha
    .replace(/\/\*[\s\S]*?\*\//g, '') // comentários de bloco
    .replace(/_/g, '') // separador de milhar do Rust
    .trim()

  if (!/^[\d\s+*]+$/.test(expr)) {
    throw new Error(`Expressão de ${tipo}::${nome} tem algo além de soma e produto: ${expr}`)
  }
  return expr
    .split('+')
    .reduce((soma, termo) => soma + termo.split('*').reduce((p, n) => p * Number(n.trim()), 1), 0)
}

describe('o tamanho das contas bate com o contrato', () => {
  test('MatchRecordV3', () => {
    expect(RECORD_LEN).toBe(constanteRust('MatchRecordV3', 'LEN'))
  })

  test('e é o que a conta realmente ocupou em devnet', () => {
    // Medido: a conta GGCvjc6Q… da partida de 07/08 tem 204 bytes. Fixar aqui o
    // valor OBSERVADO fecha o triângulo — se o Rust e o TS mudassem juntos para
    // um número errado, os dois testes de cima continuariam passando.
    expect(RECORD_LEN).toBe(204)
  })
})

describe('a conta de aluguel', () => {
  test('a fórmula bate com o que a rede cobrou', () => {
    // O ciclo em devnet mostrou 0,002311 SOL — que é (204 + 128) × 6960 lamports.
    expect(Number(recordRentLamports())).toBe((204 + 128) * 6960)
  })

  test('não depende mais do tamanho do replay', () => {
    // A assinatura perdeu o parâmetro na v3, e é o ponto: um registro de
    // tamanho fixo custa o mesmo numa partida de 3 tacadas e numa de 78.
    expect(recordRentLamports.length).toBe(0)
  })

  test('a sobrecarga de 128 bytes por conta está na fórmula', () => {
    // Foi o que fez a economia ser 2,5× em vez das duas ordens de grandeza que
    // a taxa fixa de transação sugeria. Esquecê-la subestima todo custo.
    expect(Number(rentLamports(0))).toBe(128 * 6960)
    expect(Number(rentLamports(1)) - Number(rentLamports(0))).toBe(6960)
  })

  test('o pote mínimo que o contrato aceita cobre o aluguel', () => {
    // `create_match` recusa uma mesa cujo pote não pague o registro. Se esta
    // conta divergisse, o cliente ofereceria mesas que o contrato rejeita.
    const aluguel = Number(recordRentLamports())
    expect(aluguel / 2).toBeLessThan(0.01 * 1e9) // mínimo configurado hoje
  })
})

/**
 * Soma o tamanho dos campos de uma `struct` do Rust, direto da fonte.
 *
 * A `Game` não tem constante de tamanho — o Anchor calcula o espaço na macro —,
 * então o único jeito de comparar é ler os campos. É trabalho a mais, e ele se
 * pagou na primeira execução: o valor em TypeScript estava 64 bytes atrasado
 * desde que o commit-reveal entrou.
 */
function tamanhoStructRust(nome: string): number {
  const bloco = new RegExp(`pub struct ${nome} \\{([\\s\\S]*?)\\n\\}`).exec(fonte)
  if (!bloco) throw new Error(`struct ${nome} não encontrada em lib.rs.`)

  const TIPOS: Record<string, number> = {
    u8: 1,
    bool: 1,
    u16: 2,
    u64: 8,
    i64: 8,
    Pubkey: 32,
  }

  let total = 8 // discriminador que o Anchor põe em toda conta
  for (const linha of bloco[1]!.split('\n')) {
    const m = /^\s*pub \w+: ([^,]+),/.exec(linha)
    if (!m) continue
    const tipo = m[1]!.trim()

    const arranjo = /^\[(\w+); (\d+)\]$/.exec(tipo)
    if (arranjo) {
      const unidade = TIPOS[arranjo[1]!]
      if (unidade === undefined) throw new Error(`Tipo desconhecido em ${nome}: ${tipo}`)
      total += unidade * Number(arranjo[2])
      continue
    }

    const fixo = TIPOS[tipo]
    // Recusa em vez de ignorar: um campo de tipo desconhecido silenciosamente
    // pulado devolveria um tamanho menor que o real — exatamente o bug que
    // este teste existe para pegar.
    if (fixo === undefined) throw new Error(`Tipo desconhecido em ${nome}: ${tipo}`)
    total += fixo
  }
  return total
}

describe('a conta Game', () => {
  test('o tamanho bate com a struct do contrato', () => {
    expect(GAME_ACCOUNT_SIZE).toBe(tamanhoStructRust('Game'))
  })

  test('inclui os dois compromissos do commit-reveal', () => {
    /*
     * O caso concreto que este arquivo nasceu para pegar.
     *
     * O commit-reveal acrescentou 32 bytes por jogador à `Game`, e o filtro do
     * `getProgramAccounts` continuou em 114. Não deu erro: deu lista vazia.
     * `fetchAllMatches` parou de enxergar qualquer mesa criada depois disso, e
     * o varredor — que é quem devolve o depósito de uma mesa com prazo vencido
     * — ficou cego sem reclamar.
     */
    expect(GAME_ACCOUNT_SIZE).toBe(178)
    expect(GAME_ACCOUNT_SIZE - 64).toBe(114) // o valor antigo, para o histórico
  })
})
