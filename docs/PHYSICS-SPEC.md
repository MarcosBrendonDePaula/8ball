# Especificação da física — versão 2

Este documento existe por um motivo específico: **permitir que alguém
reimplemente a simulação do zero, sem o nosso código**, e obtenha exatamente
os mesmos resultados.

Os replays das partidas estão gravados na blockchain. Sem esta especificação,
eles são bytes sem significado no dia em que este repositório sumir. Com ela,
qualquer pessoa constrói um verificador independente.

**Impressão digital desta versão:** `8348dd95`

Uma implementação correta produz esse digest ao rodar a bateria de referência
(seção 9). Se o seu digest for outro, a implementação divergiu em algum ponto.

### Errata desta revisão

O texto ancorado on-chain para a física v2 (procedência
`6mcMRNi8X6Uy9pbW4Nv4UWfMbwEbWUSZVHCTNYmHtz1R`) contém três erros encontrados
depois, numa auditoria adversarial. Esta revisão os corrige, então **o hash
deste arquivo não bate mais com o gravado na blockchain**.

O conflito é deliberado e a escolha é consciente: a procedência é imutável por
desenho — se fosse editável, alguém trocaria a especificação depois de partidas
jogadas — e um documento que induz ao erro vale menos que um hash que confere.
A revisão ancorada continua sendo o registro histórico; esta é a que serve para
reimplementar.

Os erros eram:

1. **A seção 9 dizia `1751bd8c`**, que é o digest da física **v1**, enquanto o
   cabeçalho já dizia `8348dd95`. Quem reimplementasse corretamente e conferisse
   pelo critério final concluiria que errou, e a seção 10 o mandaria caçar bugs
   inexistentes.
2. **Não dizia que encaçapar zera a velocidade e o efeito da bola.** Uma
   reimplementação fiel ao texto marcaria `pocketed` e pararia aí; como o hash
   do estado absorve a velocidade de todas as bolas, o digest sairia diferente.
3. **Não dizia que o conjunto de bolas ativas é recalculado a cada
   sub-iteração** do laço de colisão, depois da captura das caçapas.

### O que mudou da versão 1

Apenas o **jitter da quebra** (seção 8). Todo o resto — aritmética, geometria,
constantes, integração, colisões, atrito, quantização — é idêntico.

A v1 deslocava cada bola em ±0,2 mm de forma independente, e isso tinha dois
defeitos simultâneos:

1. A resolução de Q16.16 é 0,0153 mm, então ±0,2 mm cabia em apenas **27
   posições distintas** por coordenada. Seeds vizinhos produziam a mesma mesa.
2. O deslocamento é por eixo, então na diagonal ele valia 0,283 mm. Duas bolas
   vizinhas podiam aproximar-se 0,566 mm contra 0,503 mm de folga, **nascendo
   sobrepostas** — a simulação começava resolvendo colisões inexistentes.

A v2 separa as duas responsabilidades: o **triângulo inteiro** desliza até
±2 mm, cobrindo os 256 valores de um byte, enquanto cada bola mantém um
deslocamento pequeno o bastante para o rack não abrir. Como todas as bolas
andam junto, as distâncias entre elas não mudam.

Replays gravados com a v1 **devem ser verificados com uma implementação da
v1**. Reproduzi-los com esta especificação dá outro resultado.

---

## 1. Aritmética

Toda a simulação usa **ponto fixo Q16.16 sobre inteiros**. Nenhuma operação em
ponto flutuante participa do cálculo.

```
Fixed = inteiro, valendo (valor / 65536)
ONE   = 65536
```

**Invariante:** `|Fixed| < 2^24`. Isso garante que produtos fiquem abaixo de
2^48 e sejam exatos em qualquer aritmética de 53 bits de mantissa.

### Operações

| Operação | Definição |
|---|---|
| `add(a,b)` | `a + b` |
| `sub(a,b)` | `a - b` |
| `mul(a,b)` | `floor((a * b) / 65536)` |
| `div(a,b)` | `floor((a * 65536) / b)`, erro se `b == 0` |
| `sqr(a)` | `mul(a, a)` |

**O arredondamento é `floor`, não truncamento.** Truncar arredonda em direção
a zero, o que trata positivos e negativos de forma diferente e acumula viés ao
longo de milhares de passos. `floor` é uniforme.

### Raiz quadrada

Newton-Raphson em inteiros, não `sqrt` de biblioteca:

```
sqrt(v):
  se v < 0: erro
  se v == 0: retorna 0
  alvo = v * 65536
  x = 1; enquanto x*x < alvo: x = x * 2
  repita:
    prox = floor((x + floor(alvo / x)) / 2)
    se prox >= x: pare
    x = prox
  retorna x
```

### Trigonometria

Tabela de 1024 entradas, construída uma vez:

```
SIN_TABLE[i] = round(sin(i * 2π / 1024) * 65536)   para i em 0..1023
```

`sin(a)`:
1. normaliza `a` para `[0, TAU)`
2. `indice = floor((a * 65536) / TAU) * 1024`
3. `i = indice >> 16`, `frac = indice & 65535`
4. interpola linear entre `SIN_TABLE[i & 1023]` e `SIN_TABLE[(i+1) & 1023]`

`cos(a) = sin(a + floor(PI / 2))`

Constantes: `PI = 205887`, `TAU = 411775` (isto é, `round(π * 65536)` e
`round(2π * 65536)`).

---

## 2. Geometria da mesa

Origem no canto inferior esquerdo. `x` cresce para a direita, `y` para cima.

| Constante | Metros | Fixed |
|---|---|---|
| `WIDTH` | 1.98 | 129761 |
| `HEIGHT` | 0.99 | 64881 |
| `BALL_RADIUS` | 0.028575 | 1873 |
| `POCKET_RADIUS` | 0.05 | 3277 |

Derivados:
- `CONTACT_DISTANCE = BALL_RADIUS * 2`
- `CUSHION_BOUNDS`: `minX = BALL_RADIUS`, `maxX = WIDTH - BALL_RADIUS`, idem em `y`

### Caçapas

Seis, na ordem de índice 0 a 5:

```
0  (0, 0)              canto
1  (WIDTH/2, 0)        meio
2  (WIDTH, 0)          canto
3  (0, HEIGHT)         canto
4  (WIDTH/2, HEIGHT)   meio
5  (WIDTH, HEIGHT)     canto
```

Uma bola é encaçapada quando `distância²(centro, caçapa) <= POCKET_RADIUS²`.

### Pontos de referência

- `HEAD_STRING_X = WIDTH / 4`
- `FOOT_SPOT = (mul(WIDTH, 0.75), HEIGHT / 2)`
- `CUE_SPOT = (HEAD_STRING_X, HEIGHT / 2)`

---

## 3. Constantes físicas

| Constante | Valor | Papel |
|---|---|---|
| `ROLLING_FRICTION` | 0.45 | desaceleração, m/s² |
| `REST_SPEED` | 0.01 | abaixo disso a bola para |
| `CUSHION_RESTITUTION` | 0.75 | velocidade retida na tabela |
| `BALL_RESTITUTION` | 0.95 | velocidade retida entre bolas |
| `SPIN_TRANSFER` | 0.6 | efeito vertical → velocidade |
| `SPIN_RETENTION` | 0.35 | efeito que sobra após um contato |
| `SPIN_CUSHION_EFFECT` | 0.35 | desvio do efeito lateral na tabela |
| `SPIN_DECAY` | 0.995 | perda de efeito por passo |
| `DT` | 1/240 | passo de integração |
| `MAX_STEPS` | 14400 | teto de passos por tacada |

Todas convertidas para Fixed com `round(valor * 65536)`.

---

## 4. Estado da bola

```
Ball {
  id: inteiro          0 = branca, 1..15 numeradas
  position: Vec        metros, Fixed
  velocity: Vec        m/s, Fixed
  spin: Vec            x = lateral, y = vertical
  spinDecay: Fixed     taxa de perda de efeito (do taco)
  pocketed: booleano
}
```

---

## 5. Passo da simulação

**A detecção de colisão é contínua, não por sobreposição.** A 14 m/s a bola
percorre 5.8cm num passo de 1/240s — o dobro do próprio diâmetro. Com detecção
discreta ela atravessaria outra bola sem tocar.

```
step(estado, dt):
  restante = dt
  repita até 64 vezes, enquanto restante > 0:

    menorTempo = restante
    colisão = nenhuma

    para cada bola ativa a:
      t = tempoAtéTabela(a, menorTempo)
      se t < menorTempo: menorTempo = t; colisão = tabela

      para cada bola ativa b depois de a:
        t = tempoAtéContato(a, b, menorTempo)
        se t < menorTempo: menorTempo = t; colisão = bolas

    avança todas as bolas por menorTempo
    restante -= menorTempo

    se não houve colisão: pare
    resolve a colisão
    captura caçapas

  captura caçapas
  aplica atrito com dt CHEIO (não o restante)
```

**A ordem de iteração importa** e é: bolas na ordem do array, pares `(i, j)`
com `j > i`. Empates de tempo são resolvidos pela primeira encontrada.

### Tempo até contato entre bolas

```
d = b.position - a.position
v = b.velocity - a.velocity
vv = |v|²
se vv == 0: sem contato
dv = d · v
se dv >= 0: sem contato        (afastando-se)
c = |d|² - CONTACT_DISTANCE²
se c <= 0: retorna 0            (já sobrepostas e se aproximando)
disc = dv² - vv * c
se disc < 0: sem contato
t = div(-dv - sqrt(disc), vv)
retorna t se 0 <= t <= limite
```

### Tempo até a tabela

Para cada eixo, se a velocidade aponta para a parede:

```
esquerda:  t = div(minX - p.x, v.x)   quando v.x < 0
direita:   t = div(maxX - p.x, v.x)   quando v.x > 0
baixo:     t = div(minY - p.y, v.y)   quando v.y < 0
cima:      t = div(maxY - p.y, v.y)   quando v.y > 0
```

Vale o menor `t` em `[0, limite]`.

---

## 6. Resolução de colisões

### Entre bolas (massas iguais)

```
normal = normalize(b.position - a.position)
se normal é nulo: nada a fazer
aproximação = (b.velocity - a.velocity) · normal
se aproximação >= 0: nada a fazer

impulso = mul(aproximação, BALL_RESTITUTION)
a.velocity += normal * impulso
b.velocity -= normal * impulso

aplicaEfeitoVertical(a, normal)
aplicaEfeitoVertical(b, -normal)
```

`aplicaEfeitoVertical(bola, direção)`:
```
se bola.spin.y == 0: nada
transferido = mul(bola.spin.y, SPIN_TRANSFER)
bola.velocity += direção * transferido
bola.spin.y = mul(bola.spin.y, SPIN_RETENTION)
```

### Com a tabela

```
desvio = mul(bola.spin.x, SPIN_CUSHION_EFFECT)

eixo X (esquerda/direita):
  bola.velocity.x = -mul(bola.velocity.x, CUSHION_RESTITUTION)
  bola.velocity.y += desvio
  bola.position.x = minX ou maxX          (cola no limite)

eixo Y (baixo/cima):
  bola.velocity.y = -mul(bola.velocity.y, CUSHION_RESTITUTION)
  bola.velocity.x += desvio
  bola.position.y = minY ou maxY

bola.spin.x = mul(bola.spin.x, SPIN_RETENTION)
```

Colar a posição no limite é obrigatório: sem isso, erro de arredondamento
deixa a bola um passo fora e ela dispara outra colisão imediatamente.

---

## 7. Atrito

Aplicado uma vez por `step`, com o `dt` cheio, **depois** de todas as
colisões:

```
perda = mul(ROLLING_FRICTION, dt)

para cada bola ativa em movimento:
  v = |velocity|
  se v <= perda ou v < REST_SPEED:
    velocity = 0
  senão:
    velocity *= div(v - perda, v)
    spin *= bola.spinDecay
```

---

## 8. Montagem e tacada

### Triângulo

15 bolas, cinco linhas, apex no `FOOT_SPOT`, crescendo em `+x`:

```
passo = CONTACT_DISTANCE + from(0.0005)
alturaLinha = mul(passo, from(0.866))

id = 1
para linha em 0..4:
  x = FOOT_SPOT.x + mul(alturaLinha, linha)
  yBase = FOOT_SPOT.y - mul(div(passo, 2), linha)
  para coluna em 0..linha:
    y = yBase + mul(passo, coluna)
    bola(id) em (x + jitter[2*(id-1)], y + jitter[2*(id-1)+1])
    id++
```

A branca começa em `CUE_SPOT`.

### Captura nas caçapas

Ao fim de cada passo, toda bola cujo CENTRO esteja dentro do raio de captura de
alguma caçapa sai da mesa:

```
para cada bola não encaçapada:
  se pocketAt(bola.posição) >= 0:
    bola.encaçapada = verdadeiro
    bola.velocidade = (0, 0)
    bola.efeito     = (0, 0)
    emite evento 'pocketed'
```

**Zerar velocidade e efeito não é detalhe de limpeza.** O hash do estado (seção
9) absorve a velocidade de TODAS as bolas, encaçapadas ou não. Uma
implementação que só marcasse `encaçapada` produziria outro digest.

O conjunto de bolas ativas é **recalculado a cada sub-iteração** do laço de
colisão, depois da captura — uma bola que caiu no meio do passo não participa
das colisões restantes daquele passo.

### Jitter da quebra

Derivado do seed de 32 bytes, em duas camadas somadas.

```
RACK_SHIFT  = from(0.002)    # deslize do triângulo inteiro, ±2mm
BALL_JITTER = from(0.0001)   # deslocamento de cada bola, ±0.1mm

espalhar(byte, amplitude) = floor((amplitude * 2 * (byte - 128)) / 255)

deslizeX = espalhar(seed[30], RACK_SHIFT)
deslizeY = espalhar(seed[31], RACK_SHIFT)

para i em 0..29:
  byte = seed[i % 32]
  proprio = espalhar(byte, BALL_JITTER)
  se i for par:  jitter[i] = proprio + deslizeX
  senão:         jitter[i] = proprio + deslizeY
```

A divisão do seed é limpa: os bytes **0 a 29** alimentam o deslocamento das
bolas, um por coordenada, e os bytes **30 e 31** alimentam o deslize do rack.
Nenhum byte serve a dois propósitos, e o deslize fica fora do laço para não
depender de quantas bolas a modalidade usa.

**Duas armadilhas que uma reimplementação precisa reproduzir:**

O `floor` torna a faixa **assimétrica**. Com `BALL_JITTER = 7` unidades, o
resultado vai de −8 a +6, não de −7 a +7. Usar arredondamento simétrico muda
as posições iniciais e o digest não bate.

O deslize é aplicado **por paridade do índice**, não por bola: índices pares
recebem `deslizeX`, ímpares `deslizeY`. Como `jitter[2*(id-1)]` é sempre par e
`jitter[2*(id-1)+1]` sempre ímpar, cada bola recebe o mesmo par (x, y) — que é
o que mantém o triângulo rígido.

### Aplicar a tacada

```
taco = clamp(parâmetros do taco)
ângulo = quantizeAim(ângulo pedido, taco)

força = clamp(power, 0, ONE)
potência = massBps, multiplicado por breakBonusBps/10000 se for a quebra
velocidade = mul(mul(MAX_SHOT_SPEED, força), potência/10000)

branca.velocity = fromAngle(ângulo) * velocidade
branca.spinDecay = spinDecayFor(taco)

se houver efeito:
  autoridade = mul(mul(MAX_SPIN, força), spinBps/10000)
  branca.spin = (clamp(sx,-1,1), clamp(sy,-1,1)) * autoridade
senão:
  branca.spin = 0
```

`MAX_SHOT_SPEED = from(12)`, `MAX_SPIN = from(2.5)`.

### Quantização da mira

```
BASE_AIM_STEP = from(0.5 * π / 180)
aimEfetivo = clamp(aimBps + (massBps - 10000), 5000, 20000)
passo = max(1, floor(BASE_AIM_STEP * aimEfetivo / 10000))
casas = max(1, round(TAU / passo))
índice = round((normalizeAngle(a) * casas) / TAU) mod casas
ângulo = floor((índice * TAU) / casas)
```

Dividir a **circunferência** em casas iguais, e não andar de passo em passo, é
o que evita uma costura onde ângulos vizinhos saltariam mais de um passo.

### Limites do taco

| Atributo | Mínimo | Máximo |
|---|---|---|
| `massBps` | 8500 | 11500 |
| `spinBps` | 8000 | 13000 |
| `aimBps` | 5000 | 20000 |
| `clothGripBps` | 9000 | 11000 |
| `breakBonusBps` | 10000 | 11500 |

Valor inválido (`NaN`, infinito, ausente) vira **10000**, nunca o teto.

`spinDecayFor(taco) = min(ONE - 1, max(0, floor(SPIN_DECAY * clothGripBps / 10000)))`

---

## 9. Bateria de referência

24 partidas determinísticas, sem aleatoriedade. Para `i` em 0..23:

```
seedByte = (i * 37 + 11) mod 256
seed = 32 bytes, todos iguais a seedByte

6 tacadas, para j em 0..5:
  ângulo   = (i * 53 + j * 71) mod 360 graus
  força    = 0.25 + ((i * 7 + j * 13) mod 76) / 100
  se j mod 3 == 0: massBps = 8500 + ((i * 91 + j * 37) mod 3001)
  se j mod 2 == 1: spinX = (((i*29 + j*17) mod 21) - 10)/10
                   spinY = (((i*43 + j*11) mod 21) - 10)/10
  isBreak = (j == 0)
```

Entre tacadas, se a branca estiver encaçapada: volta ao `CUE_SPOT`, zerada.

### Hash

FNV-1a de 32 bits sobre os inteiros, byte a byte em little-endian:

```
estado = 0x811c9dc5
para cada inteiro v:
  para 4 bytes:
    estado = ((estado XOR (v & 0xff)) * 0x01000193) mod 2^32
    v = v >> 8
```

`hashState` absorve, para cada bola em ordem: `id`, `position.x`,
`position.y`, `velocity.x`, `velocity.y`, `pocketed ? 1 : 0`.

`hashEvents` absorve, por evento:
- `ball-ball`: `1, a, b, speed`
- `ball-cushion`: `2, ball, cushion, speed`
- `pocketed`: `3, ball, pocket`

Resultado em hexadecimal de 8 dígitos.

### Digest da bateria

Cada partida produz `hashInicial : (hashEstado : hashEventos) × 6`, juntos por
`:`. O digest final é FNV-1a sobre `nome=resultado` de cada partida, em ordem
alfabética de nome (`partida-00` a `partida-23`).

**O resultado tem de ser `8348dd95`.**

---

## 10. O que fazer se divergir

Reimplementar e obter outro digest quer dizer que algum ponto acima foi lido
diferente. Os lugares mais prováveis, em ordem:

1. **Arredondamento** — usar truncamento no lugar de `floor`
2. **Ordem de iteração** dos pares de bolas
3. **Atrito com o `dt` do sub-passo** em vez do `dt` cheio
4. **Não colar a posição** no limite após bater na tabela
5. **`sqrt` de biblioteca** em vez do Newton inteiro
6. **Tabela de seno** com número de entradas diferente

Para isolar, compare os hashes partida a partida em vez de só o digest final:
a primeira que divergir aponta a região do problema.
