# Plano: a partida acontece na chain

Hoje o servidor é dono da partida e a blockchain guarda o resultado. Este plano
inverte isso: **cada tacada é uma transação assinada e paga pelo jogador**, e o
servidor vira simulador e coordenador.

## Princípio

**A chain é a verdade, e o jogo espera por ela.**

Nada de execução otimista com reconciliação depois. Uma tacada só vale quando
confirmada; se a rede engasgar, a partida espera. É mais lento, e é a única
forma de nunca existir uma mesa mostrando algo que a chain não confirma.

A consequência que precisa vir junto: **o relógio de tacada pausa enquanto a
confirmação não volta.** Sem isso, uma congestão da rede custaria o turno de
quem já jogou — punir o jogador por lentidão nossa seria o oposto do objetivo.

## O que isso resolve

### O referee perde a capacidade de fabricar tacadas

É a terceira âncora, a que faltava. Os commits do seed e o criador já estão na
chain; falta a autenticidade das entradas. Com cada tacada assinada por quem a
fez, o referee só consegue mentir sobre o RESULTADO — e isso qualquer pessoa
detecta reproduzindo os bytes.

O que sobra de confiança fica reduzido a "o referee aplica as regras
corretamente", que é verificável por qualquer um.

### O teto de tacadas desaparece

O teto de 78 existe por um motivo só: o replay inteiro precisa caber numa
transação de 1232 bytes. Anexando 5 bytes por vez, esse limite deixa de valer.

| Tacadas | Depósito acumulado |
|---|---|
| 20 | 0,0041 SOL |
| 78 | 0,0069 SOL |
| 150 | 0,0104 SOL |
| 300 | 0,0178 SOL |

Cresce com a partida, e quem paga é quem alonga — o que também remove o
free-roll de esticar a partida de propósito, porque esticar passa a custar.

### O custo sai de nós

| | Hoje | Depois |
|---|---|---|
| Taxa de cada tacada | — | **jogador** · 0,000005 |
| Depósito da tacada | pote, no fim | **jogador** · 0,000035 |
| Depósito base do registro | pote | pote |
| Taxa da liquidação | nós · 0,000005 | nós · 0,000005 |

**0,000040 SOL por tacada**, do bolso de quem tacou. Uma partida de 40 tacadas
custa 0,0016 SOL ao jogador — menos de um centavo.

## O que muda em cada camada

### Contrato

Três instruções novas e uma mudança:

```
authorize_session(match_id, session_pubkey)
  Grava no `Game` a chave efêmera que pode tacar por este jogador.
  Assinada pela carteira de verdade, UMA vez por partida.

append_shot(match_id, shot: [u8; 5])
  Anexa ao registro. Assinada pela CHAVE DE SESSÃO, que também paga.
  Confere que é a vez de quem assina — o contrato não sabe as regras, mas
  sabe de quem é a vez porque o servidor a registra em `advance_turn`.

append_action(match_id, kind, payload)
  Mesma coisa para bola na mão, decisão e caçapa declarada.

settle_match(...)
  Deixa de carregar o replay: ele já está na chain, tacada por tacada.
  Passa a carregar só o vencedor e o hash do que foi gravado.
```

O ponto delicado: **o contrato não conhece as regras**, então não sabe validar
de quem é a vez. Duas saídas, e a segunda é melhor:

1. O servidor assina um "de quem é a vez" a cada troca. Volta a confiar nele.
2. O contrato aceita tacada de qualquer um dos dois e grava **quem assinou**.
   A ordem e a legalidade são julgadas na reprodução — que é onde as regras
   vivem de qualquer forma. Uma tacada fora de turno vira um replay que não
   verifica, e o vencedor declarado com base nela é detectável.

A segunda mantém o contrato burro, que é o que o torna auditável.

### Cliente

- Gera a chave de sessão no navegador ao entrar na mesa
- **Funda a chave na mesma transação do depósito** — sem passo nem prompt extra
- Assina e envia cada tacada com ela, sem prompt
- Espera a confirmação antes de liberar a próxima ação
- Mostra o estado da rede: "gravando na chain…" com o custo acumulado

### Servidor

Deixa de ser autoridade sobre as tacadas. Continua:

- simulando, para a interface e para detectar o fim
- cuidando do relógio, pausado durante confirmações
- liquidando, com o vencedor que as regras apontam

Passa a **ler a chain** em vez de acreditar no cliente — se a tacada não está
gravada, ela não aconteceu.

### Replay

O formato deixa de ser um blob único e vira o próprio conteúdo da conta,
escrito incrementalmente. `MAX_SHOTS`, `MAX_PLACEMENTS`, `MAX_DECISIONS` e
`MAX_CALLS` deixam de existir.

Cada entrada ganha 1 byte de tipo e 32 bytes de quem assinou? **Não** — a chave
de sessão já identifica o jogador, e ela está no `Game`. Basta 1 bit no tipo.

## Fases

Entregáveis independentes, cada um com valor sozinho:

**1. Chave de sessão** — autorização e financiamento junto do depósito. Sem
mudar o fluxo do jogo. Testável isolada.

**2. Anexar tacadas** — `append_shot` no contrato, cliente assinando, servidor
lendo da chain. O replay ainda vai inteiro na liquidação, então nada quebra se
algo falhar aqui.

**3. Liquidação lê da chain** — `settle_match` para de carregar o replay. É aqui
que o teto some.

**4. Demais ações** — bola na mão, decisão, caçapa.

## O que perdemos

**Latência.** Cada ação espera confirmação. Em rede saudável são ~0,5–1s; em
congestão, mais. O relógio pausa, mas a espera é visível.

**Jogabilidade offline.** O hotseat em `/play.html` continua local e sem chain,
mas a mesa apostada deixa de funcionar sem rede.

**Simplicidade.** É a mudança mais estrutural desde o começo. Três camadas
mexidas, contrato redeployado, e um modo de falha novo: a tacada que não
confirma.

## O que fica aberto

**A tacada que não confirma.** Blockhash expirado, taxa insuficiente, RPC fora.
O cliente precisa reenviar, e o servidor precisa distinguir "ainda não chegou"
de "não vai chegar". O relógio pausado não pode pausar para sempre.

**A chave de sessão fica com o SOL que sobrou.** Uma partida de 20 tacadas usa
0,0008 dos 0,0016 fundados. O resto vira poeira numa chave descartada, a menos
que a liquidação a recolha.

**Quem paga a primeira tacada de uma partida que ninguém quer terminar.** Se um
jogador some, o outro precisa seguir tacando — e pagando — até a partida
acabar. Hoje o relógio faz isso de graça, no servidor.
