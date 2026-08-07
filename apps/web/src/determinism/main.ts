import golden from '../../../../packages/engine-physics/src/fixtures.golden.json'
import { FIXTURES, fixturesDigest, runFixture } from '@zinc-pool/engine-physics'

/**
 * Verificação de determinismo no navegador.
 *
 * Roda a MESMA bateria que o teste do servidor e compara com os MESMOS hashes
 * gravados. É a única forma de provar que a premissa central do TDD §4 se
 * sustenta: se Chrome e servidor divergirem em um único hash, a predição local
 * no cliente não funciona e o replay público não prova nada.
 *
 * Página separada de propósito — é ferramenta de verificação, não parte do
 * jogo. Abra em cada navegador que você pretende suportar.
 *
 * Por isso ela também não carrega folha de estilo nenhuma, nem o Tailwind: o
 * estilo mora em atributos `style` para que a página continue legível mesmo se
 * o build de CSS quebrar. Uma ferramenta de diagnóstico que depende do resto do
 * sistema não serve para diagnosticar o sistema.
 */

const app = document.getElementById('app')!

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

type Linha = { nome: string; esperado: string; obtido: string; ok: boolean }

function verificar(): { linhas: Linha[]; digest: string; digestOk: boolean; ms: number } {
  const inicio = performance.now()

  const linhas: Linha[] = FIXTURES.map((fixture) => {
    const esperado = (golden.fixtures as Record<string, string>)[fixture.name] ?? '(sem referência)'
    const obtido = runFixture(fixture)
    return { nome: fixture.name, esperado, obtido, ok: obtido === esperado }
  })

  const digest = fixturesDigest()
  return {
    linhas,
    digest,
    digestOk: digest === golden.digest,
    ms: Math.round(performance.now() - inicio),
  }
}

const { linhas, digest, digestOk, ms } = verificar()
const falhas = linhas.filter((l) => !l.ok)
const passou = falhas.length === 0 && digestOk

// Exposto para inspeção automatizada — é assim que a verificação entra em CI
// ou é lida por uma ferramenta de browser sem depender de ler a tela.
;(window as unknown as Record<string, unknown>).__determinism = {
  passou,
  digest,
  digestEsperado: golden.digest,
  total: linhas.length,
  falhas: falhas.map((f) => ({ nome: f.nome, esperado: f.esperado, obtido: f.obtido })),
  ms,
  userAgent: navigator.userAgent,
}

app.innerHTML = `
  <main style="max-width:820px;margin:40px auto;padding:0 20px;
               font:14px/1.6 ui-sans-serif,system-ui,sans-serif;
               color:#e8f3ec;background:#08170f">
    <h1 style="font-size:20px;margin:0 0 4px">Determinismo da engine</h1>
    <p style="color:#8fae9d;font-size:13px;margin:0 0 20px">
      ${linhas.length} partidas de referência, ${ms}ms
    </p>

    <div style="padding:14px 16px;border-radius:10px;margin-bottom:20px;
                border:1px solid ${passou ? 'rgba(79,209,139,.4)' : 'rgba(255,132,128,.4)'};
                background:${passou ? 'rgba(79,209,139,.08)' : 'rgba(255,132,128,.08)'};
                color:${passou ? '#4fd18b' : '#ff8480'}">
      <strong style="font-size:15px">
        ${passou ? 'Idêntico ao servidor' : `DIVERGIU em ${falhas.length} partida(s)`}
      </strong>
      <div style="font:12px ui-monospace,monospace;color:#8fae9d;margin-top:6px">
        digest obtido &nbsp; ${esc(digest)}<br />
        digest esperado ${esc(golden.digest)}
      </div>
    </div>

    ${
      falhas.length
        ? `<table style="width:100%;border-collapse:collapse;font:12px ui-monospace,monospace">
             <tr style="color:#8fae9d;text-align:left">
               <th style="padding:6px 8px">partida</th><th>esperado</th><th>obtido</th>
             </tr>
             ${falhas
               .map(
                 (f) => `<tr style="border-top:1px solid #163a29">
                   <td style="padding:6px 8px">${esc(f.nome)}</td>
                   <td style="color:#8fae9d">${esc(f.esperado.slice(0, 24))}…</td>
                   <td style="color:#ff8480">${esc(f.obtido.slice(0, 24))}…</td>
                 </tr>`,
               )
               .join('')}
           </table>`
        : `<p style="color:#8fae9d;font-size:12px">
             Todas as ${linhas.length} partidas reproduziram os hashes gravados.
             Este navegador concorda com o servidor bit a bit.
           </p>`
    }

    <p style="color:#4a6a56;font-size:11px;margin-top:24px;overflow-wrap:anywhere">
      ${esc(navigator.userAgent)}
    </p>
  </main>`
