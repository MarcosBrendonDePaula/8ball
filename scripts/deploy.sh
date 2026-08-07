#!/usr/bin/env bash
# Build + deploy do programa em devnet, seguido da configuração das chaves.
#
# Roda dentro do WSL (a toolchain Rust/Agave vive lá — ver docs/SETUP-SOLANA.md).
# Do Windows:  wsl -d Ubuntu-22.04 -e bash /mnt/e/8ball/scripts/deploy.sh
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."

PROGRAMA=$(solana address -k target/deploy/pool_escrow-keypair.json)
CARTEIRA=$(solana address)
SALDO=$(solana balance --lamports | cut -d' ' -f1)

# Um redeploy escreve o binário num buffer temporário antes de trocar. O rent
# desse buffer é devolvido no fim, mas precisa estar disponível na hora.
NECESSARIO=2100000000

echo "programa  $PROGRAMA"
echo "carteira  $CARTEIRA"
echo "saldo     $(echo "scale=4; $SALDO/1000000000" | bc) SOL"
echo

if [ "$SALDO" -lt "$NECESSARIO" ]; then
  echo "Saldo insuficiente. O deploy precisa de ~2.1 SOL de buffer temporário."
  echo "Envie SOL de devnet para $CARTEIRA em https://faucet.solana.com"
  exit 1
fi

echo "== build =="
cargo-build-sbf --manifest-path programs/pool_escrow/Cargo.toml

echo
echo "== deploy =="
solana program deploy target/deploy/pool_escrow.so \
  --program-id target/deploy/pool_escrow-keypair.json

echo
echo "== IDL =="
mkdir -p target/idl
anchor idl build -o target/idl/pool_escrow.json

echo
echo "Deploy concluído. Configure as chaves com:"
echo "  bun scripts/admin.ts set-keys ~/.config/solana/id.json"
