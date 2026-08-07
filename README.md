# ZINC Pool

Sinuca 1v1 com aposta em SOL na Solana. Duas modalidades — **8-Ball** e
**sinuca brasileira** — com física determinística e partidas auditáveis por
qualquer pessoa, para sempre.

| | |
|---|---|
| Program ID | `4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht` |
| Rede | devnet |
| Física | v1 · digest `1751bd8c` |
| Testes | 502 |

## Rodar

```bash
bun install
bun run dev          # servidor :8787 + cliente :5173
```

Precisa de SOL de devnet: <https://faucet.solana.com>, com a Phantom na rede
de teste. Ou use o botão **Pedir SOL de teste** na própria interface.

| Página | O quê |
|---|---|
| `/` | lobby com mesas e depósitos |
| `/play.html` | mesa jogável (hotseat, sem rede nem dinheiro) |
| `/mesa.html` | mesa apostada contra outra pessoa |
| `/admin.html` | mesas abertas, cofres, prazos |
| `/determinism.html` | verifica se este navegador reproduz a física |

## Comandos

```bash
bun run test         # todos os pacotes
bun run typecheck
bun run verify       # estado on-chain e serviços
bun run cycle <key>  # ciclo completo do dinheiro em devnet
bun run replay <key> # grava e verifica um replay on-chain
```

Administração do contrato:

```bash
bun scripts/admin.ts show
bun scripts/admin.ts set-splits <key> 95 2.5 2.5
bun scripts/admin.ts provenance <key> <url-do-spec>
bun scripts/admin.ts pause <key>
```

## Por que isto é auditável

Uma partida inteira cabe em ~360 bytes: o seed da quebra, o vetor de cada
tacada e as escolhas que o jogador fez. Esses bytes ficam **gravados on-chain**
junto da liquidação.

Como a física é determinística, qualquer pessoa reproduz a partida a partir
deles e confere se o vencedor declarado é o correto. Quatro amarras sustentam
isso, e as duas últimas foram acrescentadas depois de uma auditoria adversarial
mostrar que sem elas a promessa não se sustentava:

| Amarra | O que ela impede |
|---|---|
| `result_hash` on-chain | trocar o replay depois da liquidação |
| **nonces gravados** | o servidor **escolher o seed** e fabricar a partida |
| a física reproduz | inventar um resultado que a simulação não dá |
| **criador gravado** | pagar o **perdedor** com a auditoria dizendo "confere" |

Sem as duas em negrito, tudo que o replay provava era "existe uma partida
coerente com estes bytes" — não que foi *aquela* partida, nem quem ganhou.

Para que isso sobreviva ao desaparecimento deste repositório,
[`docs/PHYSICS-SPEC.md`](docs/PHYSICS-SPEC.md) descreve a simulação em detalhe
suficiente para reimplementá-la do zero, e `publish_provenance` ancora o hash
desse documento on-chain.

> **O hash ancorado não bate com o arquivo atual.** Uma auditoria encontrou
> três erros no texto ancorado, incluindo um digest errado no critério de
> aceitação. A procedência é imutável por desenho, então a correção é uma
> revisão nova, com a errata registrada no próprio documento. Um documento que
> induz ao erro vale menos que um hash que confere.

## Documentação

| Documento | Para quê |
|---|---|
| [`ARQUITETURA.md`](docs/ARQUITETURA.md) | mapa do sistema e as decisões |
| [`PHYSICS-SPEC.md`](docs/PHYSICS-SPEC.md) | reimplementar a física do zero |
| [`TDD.md`](docs/TDD.md) | desenho original e marcos |
| [`SETUP-SOLANA.md`](docs/SETUP-SOLANA.md) | toolchain Rust/Anchor |

## Estrutura

```
packages/
  engine-physics/   simulação determinística (ponto fixo, colisão contínua)
  engine-rules/     8-Ball (WPA) e sinuca brasileira (CBBS)
  replay/           formato binário e verificação
  protocol/         mensagens cliente ↔ servidor
  chain-client/     instruções do programa Solana
apps/
  server/           lobby, autenticação, faucet
  web/              jogo, admin, verificador
programs/
  pool_escrow/      contrato em Rust (Anchor)
```

## Onde cada coisa roda

| Componente | Onde | Por quê |
|---|---|---|
| Física e regras | servidor **e** navegador | mesma engine dos dois lados permite prever sem divergir |
| Escrow e pagamento | on-chain | é o que precisa ser sem confiança |
| Replay | on-chain | auditoria que não depende de nós |
| Render | navegador | Canvas 2D; a física é 2D, 3D seria cosmético |

