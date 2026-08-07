# Arquitetura

Mapa do sistema: o que existe, onde roda, e por que cada decisão foi tomada.
Para o desenho original e a sequência de marcos, ver [`TDD.md`](TDD.md).
Para reimplementar a física, ver [`PHYSICS-SPEC.md`](PHYSICS-SPEC.md).

---

## 1. A ideia em uma frase

Duas pessoas depositam SOL num contrato, jogam uma partida de sinuca, e o
contrato paga o vencedor — de um jeito que **qualquer pessoa consegue conferir
que o vencedor foi mesmo quem ganhou**, sem confiar em nós.

Tudo o que segue existe para sustentar a segunda metade dessa frase.

---

## 2. Onde cada coisa roda

```
┌─ NAVEGADOR ─────────────────┐   ┌─ SERVIDOR (Bun) ───────────┐
│  interface, mesa, mira      │   │  lobby, salas, auth        │
│  engine de física  ◄────────┼───┼─►  engine de física        │
│  engine de regras  ◄────────┼───┼─►  engine de regras        │
│  Phantom (assina)           │   │  referee (assina o result.)│
└──────────┬──────────────────┘   └──────────┬─────────────────┘
           │                                  │
           │  depósitos                       │  liquidação
           ▼                                  ▼
      ┌─ SOLANA ────────────────────────────────────┐
      │  pool_escrow: custódia, pagamento, replay   │
      └─────────────────────────────────────────────┘
```

**A mesma engine roda nos dois lados.** Não é duplicação por descuido: é o que
permite ao cliente prever a tacada e mostrar o resultado na hora, sabendo que
o servidor vai chegar exatamente ao mesmo lugar.

---

## 3. Pacotes

```
packages/
  engine-physics/   simulação determinística da mesa
  engine-rules/     regras — 8-Ball e sinuca brasileira
  replay/           formato binário e verificação
  protocol/         mensagens cliente ↔ servidor
  chain-client/     instruções e leitura do programa Solana

apps/
  server/           lobby, autenticação, faucet de devnet
  web/              jogo, painel admin, verificador

programs/
  pool_escrow/      contrato em Rust (Anchor)
```

Cada um é independente e testado sozinho. A dependência anda numa direção só:
`web` e `server` dependem dos pacotes; nenhum pacote depende deles.

---

## 4. Física — `engine-physics`

### Por que não usar engine pronta

Matter.js, Box2D, Rapier, PhysX: todas usam ponto flutuante, e float não é
bit-idêntico entre plataformas. Com qualquer uma delas, duas máquinas podem
discordar sobre onde a bola parou — e aí não existe auditoria, existe "confie
no servidor".

### Como o determinismo é obtido

**Ponto fixo Q16.16 sobre inteiros.** Nenhuma operação em float participa do
cálculo. `Math.sin` e `Math.sqrt` aparecem só na construção da tabela de seno,
uma vez, em tempo de carga.

**Arredondamento uniforme (`floor`).** Truncar arredondaria em direção a zero,
tratando positivos e negativos diferente, e o viés se acumula ao longo de
milhares de passos.

**Colisão contínua.** A 14 m/s a bola percorre 5.8cm num passo de 1/240s — o
dobro do próprio diâmetro. Detecção por sobreposição a deixaria atravessar
outra bola. Cada passo resolve o instante exato do primeiro contato.

### Como o determinismo é verificado

Uma bateria de 24 partidas de referência produz um digest. Ele precisa ser
idêntico em toda plataforma:

```
Bun (servidor)   1751bd8c
Chrome           1751bd8c   ✓ verificado
Firefox          não verificado
Safari / iOS     não verificado
```

Abra `/determinism.html` em qualquer navegador para conferir.

### Versão da física

```ts
ENGINE_VERSION = 1
PHYSICS_DIGEST = '1751bd8c'
```

Um teste compara o digest declarado com o calculado. **Mudar a física sem
incrementar a versão quebra o build** — e é para quebrar: um replay gravado
antes passaria a ser reproduzido com regras novas e poderia apontar outro
vencedor, em silêncio.

---

## 5. Regras — `engine-rules`

Duas modalidades, cada uma autocontida:

```
eightball/   8-Ball americano, World Standardized Rules da WPA
sinuca/      sinuca brasileira, regras da CBBS
mode.ts      interface comum + registro
```

O servidor e o cliente falam **só** com `getGameMode(id)`. Nenhum deles sabe
qual jogo está rodando, e acrescentar uma terceira modalidade é criar uma
pasta e registrar. Um teste percorre todas as modalidades e exige que cada uma
cumpra o contrato inteiro — se a indireção parar de valer, ele avisa antes de
alguém espalhar `if (modo === 'sinuca')` pelo projeto.

Funções **puras**: o mesmo par (estado, tacada) sempre produz o mesmo
julgamento. É isso que permite servidor e cliente julgarem sem discordar.

### Diferenças que o código precisa refletir

| | 8-Ball | Sinuca |
|---|---|---|
| Alvo | grupo do jogador | a menor bola da mesa, para os dois |
| Vitória | encaçapar a 8 | placar |
| Falta | passa a vez | 7 pontos ao adversário |
| Bola errada encaçapada | fica na caçapa | volta para a mesa |

### Pontos da regra oficial que costumam ser implementados errado

- Encaçapar a 8 **na quebra** não é falta nem derrota: o quebrador escolhe
  entre recolocar a 8 e seguir, ou quebrar de novo
- Com a mesa aberta, bater primeiro na 8 **é falta** — "aberta" não quer dizer
  que tudo vale
- Quebra inválida dá **três** opções ao adversário
- Falta na quebra restringe a bola na mão à cozinha; fora da quebra, não

---

## 6. Replay — `replay`

### O formato

58 bytes de cabeçalho, 5 por tacada, 1 por decisão. Uma partida de 60 tacadas
ocupa **~360 bytes**.

```
0      versão do FORMATO      como ler os bytes
1      modalidade
2      versão da FÍSICA       com que comportamento reproduzir
3      número de decisões
4..35  seed da quebra
36..55 tacos dos dois jogadores
56..57 número de tacadas
58..   tacadas
depois decisões, 1 byte cada
```

As duas versões precisam estar lá, e por razões diferentes: a primeira diz
como decodificar, a segunda diz qual simulação usar.

### O orçamento de bytes é medido, não estimado

Uma transação da Solana não passa de **1232 bytes**, e um `settle_match` sem
replay nenhum já gasta **510** com assinaturas, contas e discriminador. Sobram
**721** para o replay, e o teto é 682 — 120 tacadas e 24 decisões — deixando
margem para uma instrução de compute budget.

Esse número já esteve errado duas vezes, e as duas de um jeito que não aparece
em teste curto: a liquidação falharia só nas partidas longas, com dinheiro na
mesa. Hoje um teste trava a igualdade entre o teto do TypeScript e o do
contrato em Rust.

### Tacada não é a única entrada do jogador

O 8-Ball abre escolhas ao adversário depois de uma quebra irregular, e uma
delas manda **armar o rack de novo**. Sem gravá-las, o replay de qualquer
partida que passasse por ali reproduziria outra coisa.

Elas entram como uma lista de índices de opção, consumida na ordem em que as
regras as abrem — o verificador deduz *quando* uma decisão acontece, então
basta gravar *qual* foi. A ordem das opções em `PendingDecision` passa a ser
parte do formato: trocá-la faria replays antigos reproduzirem outra escolha.

### Jogo e verificador chamam o MESMO código

`engine-rules/bridge.ts` é dono de duas operações que decidem o resultado:
traduzir eventos da física para o vocabulário das regras, e devolver as bolas à
mesa depois do julgamento.

Elas moram num lugar só porque já houve **duas cópias** — uma no jogo, outra no
verificador — e elas divergiram: o verificador não devolvia as bolas à mesa.
Numa partida de sinuca de 60 tacadas, 21 devolveram bola e 26 bolas ao todo, e
o verificador simulava a mesa sem nenhuma delas. **Toda partida de sinuca era
auditada errado.**

A regra, para quem mexer ali: se o jogo e o verificador não chamarem
exatamente a mesma função, o replay não prova nada.

### A decisão que torna isso possível

**A tacada é quantizada na origem, não na gravação.**

```
ângulo  u16  → 65.536 direções
força   u8   → 256 níveis
efeito  i8   → 255 por eixo
```

O jogador envia esses inteiros, a engine simula esses inteiros, e é isso que
fica gravado. Se a quantização acontecesse só ao gravar, o replay reproduziria
uma partida *ligeiramente* diferente e o hash não bateria.

### A verificação

```ts
const registro = await fetchMatchRecord(connection, matchId)
const replay = decodeReplay(registro.replay)
const prova = replayProves(replay, {
  winner: 0,
  resultHash: registro.resultHash,
})
```

Antes de reproduzir, `checkEngineCompatibility` faz duas checagens:

1. a **versão** declarada bate com a desta engine
2. a **impressão digital** calculada bate com a declarada

A segunda pega o caso perigoso — alguém alterou a física mantendo o número da
versão. Sem ela, uma cópia adulterada verificaria replays antigos com regras
novas e pareceria legítima.

---

## 7. O contrato — `pool_escrow`

**Program ID:** `4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht` (devnet)

O contrato não sabe nada sobre sinuca. Ele guarda dinheiro e paga segundo
regras que ninguém — nem o operador — consegue burlar depois de publicado.

### Contas

| Conta | Semente | Papel |
|---|---|---|
| `Config` | `["config"]` | authority, referee, limites, divisão do pote |
| `Game` | `["match", id]` | custódia dos dois depósitos |
| `Vault` × 2 | `["house"]`, `["treasury"]` | taxas acumuladas |
| `MatchRecord` | `["replay", id]` | registro permanente da partida |
| `Provenance` | `["provenance", versão]` | como reimplementar a física |

### Instruções

```
initialize          configura o programa (uma vez)
migrate_config      evolui o layout do Config sem perder estado
set_config          troca referee e limites
set_splits          ajusta a divisão do pote, com piso de 85% ao vencedor
set_authority       passa a autoridade adiante
set_paused          freio de emergência
init_vaults         cria os cofres
create_match        cria a mesa e deposita a entrada do criador
join_match          oponente deposita o mesmo valor
cancel_match        devolve, se ninguém entrou
settle_match        paga o vencedor e grava o replay
claim_timeout       destrava partida abandonada
withdraw_house      saca do cofre da casa
burn_treasury       queima do cofre de protocolo
publish_provenance  ancora a especificação da física
```

### Garantias que não dependem de confiança

**O dinheiro fica numa PDA sem chave privada.** Nem nós conseguimos sacar fora
das regras.

**O vencedor nunca recebe menos de 85%.** `MIN_WINNER_BPS` é constante no
código: baixá-lo exige publicar um binário novo, o que é público e auditável.
Não basta uma transação discreta.

**Fundos nunca ficam presos.** Depois do prazo, `claim_timeout` e
`cancel_match` podem ser acionados por **qualquer um**, e o dinheiro volta
para os jogadores de qualquer forma. Se o servidor e o referee sumirem, o
dinheiro sai.

**A procedência é imutável.** Uma vez publicada, a especificação de uma versão
da física não muda. Especificação errada exige publicar uma versão nova — a
antiga fica intacta, e os replays dela continuam válidos.

### O elefante: o referee

Uma chave decide quem ganhou. Isso é confiança real que o jogador deposita, e
não adianta fingir o contrário. O que a contrabalança:

1. O replay inteiro está on-chain — qualquer um reproduz e confere
2. Declarar o vencedor errado é **detectável por qualquer pessoa, para sempre**
3. A chave vive isolada, e `set_config` permite rotacioná-la
4. `claim_timeout` limita o dano de um referee que suma

---

## 7.5. A partida em rede — `match` e `matches`

### O servidor decide, o cliente prevê

O cliente manda um vetor de tacada e recebe o que aconteceu. Ele simula em
paralelo para animar sem esperar a rede, mas o que vale é a cópia do servidor.
Cada `match.shot` carrega o **hash do estado resultante**: se a previsão do
cliente divergir, ele sabe na hora, em vez de mostrar uma mesa falsa até o fim.

A tacada trafega **já quantizada** — os mesmos u16/u8/i8 do replay. Não existe
conversão no meio do caminho onde os dois lados possam discordar por um bit.

### A quebra por commit-reveal

Cada jogador sorteia 32 bytes em segredo e publica só o hash. Com os dois
comprometidos, ambos revelam, e o seed é `sha256(nonceA ‖ nonceB)`.

Sem isso, quem escolhesse o seed escolheria a quebra: com física
determinística, escolher a quebra é escolher onde as bolas param — bastaria
procurar offline um seed favorável. A conferência do nonce contra o commit é o
que impede o segundo a revelar de escolher depois de ver o do adversário.

### Tempo: um relógio, três regras

| Regra | Prazo | Consequência |
|---|---|---|
| Revelação | 60s | partida anulada, sem vencedor |
| Tacada | 45s | falta; 3 seguidas = W.O. |
| Desconexão | 90s | W.O. por abandono |

Estourar o prazo de tacada **não inventa uma transição nova**: é registrado
como uma tacada de força zero. A branca não sai do lugar, as regras julgam
falta por falta de contato — que é o que a WPA prescreve — e o replay reproduz
tudo sem nenhum caso especial, por 5 bytes.

Dois detalhes que custaram a acertar:

**A falta passa a vez**, então dois jogadores parados alternam e cada um só
acumula falta no próprio turno. O W.O. leva o dobro de rodadas.

**Só a tacada voluntária zera a contagem.** Se a tacada nula do relógio também
zerasse, o jogador estouraria o prazo para sempre e prenderia o dinheiro.

### Por que o relógio é injetado

A `Match` é lógica pura: o tempo entra por parâmetro e nada ali abre socket. O
`Matches` é o único lugar que lê `Date.now()`, com um `tick` para todas as
partidas em vez de um `setTimeout` por prazo — com um timer por turno, cancelar
e reagendar é o caminho mais curto para um W.O. disparado numa partida que já
acabou.

O ganho aparece nos testes: 24 casos cobrem prazo, W.O., abandono e
reconexão sem esperar um segundo sequer.

---

## 7.6. Destravamento automático — `sweeper`

Uma mesa em que os dois depositaram e ninguém liquidou fica com o dinheiro
preso na PDA. O contrato já resolve — `claim_timeout` devolve a entrada de cada
um depois do prazo — mas alguém precisa **chamar**. Esse alguém era uma pessoa
clicando "Destravar" no painel; se ninguém abrisse o painel, o dinheiro ficava
lá.

### Por que automatizar isto é seguro

O contrato foi escrito para permitir:

```rust
pub struct ClaimTimeout<'info> {
    /// Qualquer um pode acionar depois do prazo — de propósito.
    pub caller: Signer<'info>,
    #[account(mut, close = creator, ...)] pub game: Account<'info, Game>,
    #[account(mut, address = game.creator)]  pub creator:  AccountInfo<'info>,
    #[account(mut, address = game.opponent)] pub opponent: AccountInfo<'info>,
}
```

Quem aciona **não escolhe o destino**: `close = creator` e os `address =` fixam
as contas contra o que está gravado na partida. O varredor não tem como
desviar um lamport — ele só paga a taxa.

Por isso ele roda com a chave do **referee**, que já vive no servidor e já só
paga taxa. Nenhuma chave nova, nenhuma permissão nova.

### As três guardas

| Guarda | Por quê |
|---|---|
| Folga de 5 min após o prazo | o contrato compara com `Clock::get()`, não com o relógio do servidor; chamar cedo dá `NotExpiredYet` e gasta taxa à toa |
| Pula partida viva neste servidor | o prazo on-chain é de uma hora, mas uma partida longa pode passar dele — devolver no meio de uma disputa é pior que esperar |
| Teto de 5 por passada | evita rajada de transações quando o servidor volta depois de um tempo fora |

Uma mesa que falha não interrompe as outras: a falha mais comum é corrida com
outra chamada que já destravou, e nesse caso o dinheiro já voltou.

### O envio é injetado

`sweepExpired` decide; quem transporta entra por parâmetro. Separar os dois é o
que permite testar as decisões — que são as que podem devolver dinheiro na hora
errada — sem imitar metade do web3.js.

---

## 8. Fluxo do dinheiro

### Criar mesa — três tempos

```
1. cliente → servidor    reserve(stake)        devolve match_id
2. cliente → Phantom     assina create_match   ← o depósito acontece aqui
3. cliente → servidor    confirmCreate         servidor LÊ a chain e publica
```

**O servidor nunca move dinheiro** — não tem como, não detém as chaves. E no
passo 3 ele não acredita no cliente: busca a conta `Match` on-chain e confere
criador, valor e estado. Se não bater, a sala não existe.

### Liquidação

```
pote = 2 × entrada
  90%  vencedor
   5%  cofre da casa       custeia operação
   5%  cofre de protocolo  reserva; vira queima quando houver token
```

Arredondamento sobra para o protocolo, nunca para o vencedor — assim a soma
nunca excede o pote.

A divisão vem do `Config` e é ajustável sem redeploy, dentro do piso de 85%.

---

## 9. O laço do jogo

Arquitetura inspirada na Unity, sem lib de engine:

```
game/core/
  time.ts       passo fixo e interpolação
  input.ts      mouse e toque unificados
  entity.ts     ciclo de vida (awake/start/fixedUpdate/update/render)
  scene.ts      lista de entidades e ordem de execução
  loop.ts       requestAnimationFrame + acumulador
  viewport.ts   mundo ↔ tela

game/objects/
  MatchController  física + regras
  TableObject      mesa
  BallsObject      bolas
  CueObject        mira e tacada
  HudObject        placar
```

**Física em `fixedUpdate`, desenho em `render`.** Não é enfeite: física em
passo variável produziria resultados diferentes em cada máquina.

O desenho **interpola** entre dois passos físicos. Sem isso, o movimento treme
mesmo com a simulação perfeita.

### Por que não Phaser

Phaser traz cenas, sprites, tweens **e uma física própria** que não podemos
usar — a nossa precisa ser determinística. Sobraria pagar ~1MB por "desenhar
círculo". Para 16 círculos, Canvas 2D basta e o laço tem ~150 linhas.

Se um dia houver efeitos visuais pesados, PixiJS entra como camada de desenho.
A engine e as regras não mudam, porque o que elas produzem são coordenadas.

### Por que 2D

A física é 2D. Um render 3D seria cosmético sobre a mesma simulação, e mirar
de cima é mais preciso — por isso os jogos de sinuca online de maior sucesso
são assim, não por limitação técnica.

---

## 10. Tacos NFT

Cinco atributos que a física lê, todos limitados no código:

| Atributo | Efeito | Faixa |
|---|---|---|
| `massBps` | mais energia — e mira mais grossa | 8.500 – 11.500 |
| `spinBps` | autoridade de efeito | 8.000 – 13.000 |
| `aimBps` | finura da mira, **menor é melhor** | 5.000 – 20.000 |
| `clothGripBps` | quanto o efeito dura | 9.000 – 11.000 |
| `breakBonusBps` | potência extra **só na quebra** | 10.000 – 11.500 |

Três regras de desenho:

**Trade-off, não escada.** Peso alto engrossa a mira automaticamente. Um teste
percorre todos os arquétipos e falha se algum dominar outro em todos os eixos
— sem isso, uma mesa com dinheiro vira "quem pagou mais ganha".

**Precisão sem sorteio.** A mira é quantizada, não perturbada. Um taco melhor
aponta em mais direções; nenhum introduz erro aleatório. Com RNG, o replay
deixaria de reproduzir a partida.

**Cosmético fora da física.** Skin, cor e rastro não influenciam nada, e há
teste provando. É ali que a monetização é segura.

---

## 11. Segurança operacional

### Chaves, uma por papel

```
authority   administra o programa      só no WSL, fora do servidor
referee     assina liquidações         paga só taxa
faucet      SOL de teste em devnet     no servidor, saldo pequeno
house/treasury  cofres PDA             sem chave privada
```

A separação existe porque, no começo, a chave do faucet **era a mesma da
authority** — o servidor segurava a upgrade authority, e comprometê-lo
permitiria publicar um contrato novo e drenar o escrow.

Todas as chaves e `.env` estão no `.gitignore`.

### Regras que evitam armadilhas conhecidas

- Entrada inválida em atributo de taco vira o **padrão**, nunca o teto
- Modalidade desconhecida é **erro**, não padrão silencioso — senão os dois
  jogadores jogariam jogos diferentes
- Versão de replay desconhecida é **recusada**, não interpretada
- Leituras de saldo esperam a propagação do RPC: ler logo após confirmar
  devolve o valor antigo

---

## 12. Estado atual

| Marco | Estado |
|---|---|
| M1 física determinística | pronto, verificado Bun ≡ Chrome |
| M2 regras | pronto, duas modalidades |
| M3 mesa jogável | pronto — mesa, mira e gravação de replay |
| M4 multiplayer | jogável de ponta a ponta; liquidação automática |
| M5 escrow on-chain | pronto e provado em devnet |

**439 testes**, typecheck limpo — agora incluindo `apps/web` e `scripts/`, que
estavam fora do pipeline. Foi essa lacuna que deixou um campo obrigatório do
replay passar despercebido até quebrar contra a devnet.

### Limitações declaradas

- Determinismo verificado em **duas** plataformas; Firefox e Safari não
- Partida com mais de **80 tacadas ou 45 faltas** não cabe na transação de
  liquidação. O gravador erra em vez de truncar
- A especificação da física está ancorada on-chain, mas hospedada **no
  GitHub**; o hash é eterno, o endereço não. Arweave fecha o ciclo
- O jitter da quebra tem **27 posições distintas por coordenada**, não 256: a
  amplitude de ±0,2 mm vale 13 unidades em ponto fixo. São 30 coordenadas
  independentes, o que basta de sobra contra precomputação, mas seeds vizinhos
  produzem a mesma mesa. Corrigir exigiria uma versão nova da física
- O teto de **120 tacadas** por partida vem da transação da Solana. Partida
  mais longa que isso não tem como ser liquidada com o replay junto
- Não há parecer jurídico sobre mesa apostada — bloqueante para mainnet
