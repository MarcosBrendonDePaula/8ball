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

58 bytes de cabeçalho mais 5 por tacada. Uma partida de 60 tacadas ocupa
**~360 bytes** — cabe numa transação da Solana.

```
0     versão do FORMATO      como ler os bytes
1     modalidade
2     versão da FÍSICA       com que comportamento reproduzir
4..35 seed da quebra
36..55 tacos dos dois jogadores
56..57 número de tacadas
58..   tacadas
```

As duas versões precisam estar lá, e por razões diferentes: a primeira diz
como decodificar, a segunda diz qual simulação usar.

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
| M3 mesa jogável | mesa e mira funcionando; falta ligar ao replay |
| M4 multiplayer | não iniciado |
| M5 escrow on-chain | pronto e provado em devnet |

**337 testes**, typecheck limpo.

### Limitações declaradas

- Determinismo verificado em **duas** plataformas; Firefox e Safari não
- O replay ainda **não grava a posição de bola na mão**; a verificação usa a
  posição canônica, então só é fiel a partidas sem falta
- A especificação da física está **neste repositório**; ancorá-la em
  armazenamento permanente (Arweave) é o passo que fecha o ciclo
- Não há parecer jurídico sobre mesa apostada — bloqueante para mainnet
