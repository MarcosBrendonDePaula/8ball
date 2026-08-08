/**
 * Determinismo da física em navegadores de verdade.
 *
 * A premissa do sistema inteiro é que a mesma tacada produz a mesma mesa em
 * qualquer lugar. Se ela não valer, a predição local diverge do servidor e um
 * replay público deixa de provar coisa alguma — o vencedor passa a depender do
 * navegador de quem confere.
 *
 * O teste do Bun já cobria isso, e a página `determinism.html` existia desde o
 * começo. O que faltava era ABRI-LA em cada navegador sem depender do protocolo
 * de depuração de cada um: o do Chrome não serve para o Firefox, e por isso o
 * Firefox nunca tinha sido verificado.
 *
 * Este arnês resolve pelo caminho que funciona em todos: sobe um servidor,
 * serve a página, e cada navegador POSTa o próprio veredito de volta.
 *
 * Cada um roda num PERFIL LIMPO E DESCARTÁVEL. Sem extensões, sem configuração
 * herdada, sem cache — o resultado tem de vir da engine, não do ambiente.
 *
 * Uso: bun scripts/check-determinism.ts [--headed]
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

type Relatorio = {
  passou: boolean
  digest: string
  digestEsperado: string
  total: number
  falhas: { nome: string; esperado: string; obtido: string }[]
  ms: number
  userAgent: string
}

const HEADED = process.argv.includes('--headed')
const DIST = join(import.meta.dir, '..', 'apps', 'web', 'dist')

const NAVEGADORES = [
  {
    nome: 'Firefox',
    caminhos: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
      '/usr/bin/firefox',
      '/Applications/Firefox.app/Contents/MacOS/firefox',
    ],
    args: (url: string, perfil: string) => [
      ...(HEADED ? [] : ['--headless']),
      '--profile',
      perfil,
      '--new-instance',
      url,
    ],
  },
  {
    nome: 'Chrome',
    caminhos: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    args: (url: string, perfil: string) => [
      ...(HEADED ? [] : ['--headless=new']),
      `--user-data-dir=${perfil}`,
      '--no-first-run',
      '--no-default-browser-check',
      // A física é toda inteira e não toca a GPU; desligá-la evita que o
      // headless morra em máquinas sem contexto gráfico.
      '--disable-gpu',
      url,
    ],
  },
] as const

if (!existsSync(join(DIST, 'determinism.html'))) {
  console.error('Build não encontrado. Rode antes:  bun run build')
  process.exit(1)
}

const recebidos = new Map<string, Relatorio>()
let resolverAtual: ((r: Relatorio) => void) | null = null

const servidor = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/report') {
      const r = (await req.json()) as Relatorio
      resolverAtual?.(r)
      return new Response('ok', { headers: { 'access-control-allow-origin': '*' } })
    }

    const arquivo = Bun.file(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname))
    return (await arquivo.exists()) ? new Response(arquivo) : new Response('404', { status: 404 })
  },
})

const base = `http://127.0.0.1:${servidor.port}`
console.log(`servindo ${DIST} em ${base}\n`)

for (const nav of NAVEGADORES) {
  const executavel = nav.caminhos.find((c) => existsSync(c))
  if (!executavel) {
    console.log(`${nav.nome.padEnd(9)} não instalado — pulado`)
    continue
  }

  const perfil = mkdtempSync(join(tmpdir(), `zinc-${nav.nome.toLowerCase()}-`))
  const url = `${base}/determinism.html?report=${encodeURIComponent(`${base}/report`)}`

  const proc = spawn(executavel, nav.args(url, perfil), { stdio: 'ignore' })

  const relatorio = await new Promise<Relatorio | null>((resolve) => {
    // O POST da página é quem resolve isto. Sem ele, o prazo: a bateria são 24
    // partidas simuladas e em máquina lenta passa de um minuto — desistir cedo
    // reportaria "não roda" para algo que só é devagar.
    const prazo = setTimeout(() => resolve(null), 120_000)
    resolverAtual = (r) => {
      clearTimeout(prazo)
      resolve(r)
    }
  })

  resolverAtual = null
  proc.kill()
  // O Firefox não solta o perfil na hora; tentar apagar imediatamente falha no
  // Windows. Não é motivo para o teste falhar — é um diretório temporário.
  try {
    rmSync(perfil, { recursive: true, force: true })
  } catch {
    /* o sistema limpa depois */
  }

  if (!relatorio) {
    console.log(`${nav.nome.padEnd(9)} SEM RESPOSTA — não conseguiu rodar a bateria`)
    continue
  }

  recebidos.set(nav.nome, relatorio)
  const marca = relatorio.passou ? '✓' : '✗'
  console.log(
    `${nav.nome.padEnd(9)} ${marca} ${relatorio.total} partidas · digest ${relatorio.digest} · ${relatorio.ms}ms`,
  )
  console.log(`          ${relatorio.userAgent}`)

  for (const f of relatorio.falhas) {
    console.log(`          DIVERGIU ${f.nome}: esperado ${f.esperado}, obteve ${f.obtido}`)
  }
  console.log()
}

servidor.stop(true)

// ------------------------------------------------------------- veredito

if (recebidos.size === 0) {
  console.error('Nenhum navegador respondeu.')
  process.exit(1)
}

const digests = new Set([...recebidos.values()].map((r) => r.digest))
const todosPassaram = [...recebidos.values()].every((r) => r.passou)

if (digests.size > 1) {
  console.error('DIVERGÊNCIA ENTRE NAVEGADORES — a mesma tacada dá mesas diferentes.')
  for (const [nome, r] of recebidos) console.error(`  ${nome}: ${r.digest}`)
  process.exit(1)
}

console.log(
  todosPassaram
    ? `Todos concordam com o Bun: digest ${[...digests][0]}`
    : 'Os navegadores concordam entre si, mas divergem dos hashes gravados.',
)
process.exit(todosPassaram ? 0 : 1)
