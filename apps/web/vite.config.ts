import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  // `@solana/web3.js` v1 referencia `global` em tempo de módulo, antes de
  // qualquer polyfill nosso rodar. Só um define resolve.
  define: { global: 'globalThis' },

  resolve: {
    alias: {
      '@': r('./src'),
      '@zinc-pool/protocol': r('../../packages/protocol/src/index.ts'),
      '@zinc-pool/chain-client': r('../../packages/chain-client/src/index.ts'),
      '@zinc-pool/engine-physics': r('../../packages/engine-physics/src/index.ts'),
      '@zinc-pool/engine-rules': r('../../packages/engine-rules/src/index.ts'),
      buffer: 'buffer',
    },
  },

  optimizeDeps: {
    include: ['buffer', '@solana/web3.js'],
  },

  server: {
    port: 5173,
    host: true,
    proxy: {
      // O cliente fala com o servidor de jogo pelo mesmo origin em dev,
      // evitando CORS e deixando a URL do WS igual em dev e produção.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Páginas separadas: o jogo, o painel e a verificação de determinismo.
      input: {
        main: r('./index.html'),
        admin: r('./admin.html'),
        determinism: r('./determinism.html'),
        play: r('./play.html'),
      },
    },
  },
})
