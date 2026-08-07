# Ambiente Solana

O programa on-chain é Rust compilado para SBF. O restante do projeto (servidor,
cliente, física) é TypeScript e **não precisa de nada disto** — só quem for
mexer em `programs/` precisa desta toolchain.

## Por que WSL

O Solana CLI 1.18 que vinha instalado no Windows embute Rust 1.75 (fev/2024).
O ecossistema de crates já exige `edition2024`, que precisa de Rust 1.85+, e as
dependências transitivas do `anchor-lang` puxam isso. Pinar versão a versão não
converge — cada pin puxa outra crate incompatível.

A toolchain fica no WSL Ubuntu-22.04; o código continua em `E:\8ball`, visível
de lá como `/mnt/e/8ball`. Nada é duplicado.

## Versões

| Ferramenta | Versão |
|---|---|
| rustc (WSL) | 1.97.1 |
| Agave / Solana CLI | 4.1.1 |
| cargo-build-sbf | 4.1.0 (platform-tools v1.54) |
| anchor-lang | 0.31.1 |

> `solana-install` está deprecado. A instalação usa o Agave (Anza), que é o
> sucessor oficial.

## Instalação (já feita)

```bash
wsl -d Ubuntu-22.04

rustup update stable
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

Para tornar o PATH permanente, acrescente essa linha ao `~/.bashrc` do WSL.

## Chaves

| Chave | Onde | Para quê |
|---|---|---|
| `target/deploy/pool_escrow-keypair.json` | repositório (ignorado pelo git) | Identidade do programa. Define o Program ID |
| `~/.config/solana/id.json` (WSL) | fora do repositório | Carteira que paga o deploy |

Program ID: `4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht`

> **Nunca comitar keypair.** O `.gitignore` já cobre `target/` e `keypairs/`.
> Perder o keypair do programa significa perder a capacidade de atualizá-lo.

## Comandos

```bash
# Build
cargo-build-sbf --manifest-path programs/pool_escrow/Cargo.toml

# Apontar para devnet e pegar SOL de teste
solana config set --url devnet
solana airdrop 2

# Deploy
solana program deploy target/deploy/pool_escrow.so \
  --program-id target/deploy/pool_escrow-keypair.json

# Conferir
solana program show 4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht
```

## Armadilha do lockfile

Se voltar a compilar pelo Windows, o `Cargo.lock` pode ser gerado em versão 4 e
a toolchain antiga não entende. O sintoma é
`lock file version 4 requires -Znext-lockfile-bump`. Como só compilamos pelo
WSL com toolchain atual, isso não deve ocorrer — mas se ocorrer, apague o
`Cargo.lock` e gere de novo pelo WSL.
