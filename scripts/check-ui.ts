/**
 * Verificação da interface em navegador headless (Bun.WebView).
 *
 * Roda o que `tsc` e os testes de unidade não alcançam: se a página monta de
 * fato, se o WebSocket conecta, se algo estoura no console em runtime.
 *
 * Uso: bun scripts/check-ui.ts [url] [--screenshot saida.png]
 */

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173'
const screenshotIdx = process.argv.indexOf('--screenshot')
const screenshotPath = screenshotIdx > -1 ? process.argv[screenshotIdx + 1] : null

type Msg = { type: string; text: string }
const mensagens: Msg[] = []

await using view = new Bun.WebView({
  width: 1100,
  height: 900,
  backend: { type: 'chrome', stderr: 'inherit' },
  dataStore: { directory: './.browser-profile' },
  console: (type: string, ...args: unknown[]) => {
    mensagens.push({ type, text: args.map(String).join(' ') })
  },
})

await view.navigate(url)

// O cliente conecta o WebSocket e busca o saldo no boot; sem esperar, a
// verificação leria uma tela ainda vazia e passaria por engano.
await new Promise((r) => setTimeout(r, 3000))

const estado = (await view.evaluate(`
  (() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null
    const badges = [...document.querySelectorAll('.badge')].map(b => b.textContent.trim())
    const botoes = [...document.querySelectorAll('button')].map(b => ({
      texto: b.textContent.trim().replace(/\\s+/g, ' '),
      desabilitado: b.disabled,
    }))
    return {
      titulo: document.title,
      montou: !!document.querySelector('.card'),
      subtitulo: t('.subtitle'),
      badges,
      botoes,
      temFaucet: !!document.querySelector('#faucet'),
      erro: t('.notice[data-tone=error]'),
      corpoVazio: document.body.innerText.trim().length < 20,
    }
  })()
`)) as Record<string, unknown>

const erros = mensagens.filter((m) => m.type === 'error')
const avisos = mensagens.filter((m) => m.type === 'warn')

console.log(JSON.stringify({ url: view.url, estado, erros, avisos }, null, 2))

if (screenshotPath) {
  await Bun.write(screenshotPath, await view.screenshot())
  console.log(`\nscreenshot: ${screenshotPath}`)
}

// Falha explícita para poder ser usado em CI.
const problemas: string[] = []
if (!estado.montou) problemas.push('a página não montou')
if (estado.corpoVazio) problemas.push('corpo vazio')
if (erros.length) problemas.push(`${erros.length} erro(s) no console`)

if (problemas.length) {
  console.error(`\nFALHOU: ${problemas.join(', ')}`)
  process.exit(1)
}
console.log('\nInterface OK.')

// Marca o arquivo como módulo, para o `await` de topo ser válido.
export {}
