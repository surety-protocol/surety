import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Settings for the hosted dashboard (npm run build:hosted). Public values only:
// the testnet contract ids and a public RPC endpoint. Receipts are served from the
// static site (copied in by scripts/copy-receipts.mjs), not from a judge.
const HOSTED: Record<string, string> = {
  VITE_USE_MOCK: 'false',
  VITE_NEAR_NETWORK: 'testnet',
  VITE_RPC_URL: 'https://test.rpc.fastnear.com',
  VITE_CONTRACT_ID: 'core.surety.testnet',
  VITE_TOKEN_ID: 'tusdc.surety.testnet',
  VITE_RECEIPTS_BASE: '/receipts',
  VITE_DEMO_API_URL: 'http://localhost:8787',
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: mode === 'hosted'
    ? Object.fromEntries(Object.entries(HOSTED).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]))
    : {},
  build: {
    rolldownOptions: {
      output: {
        // Split vendor chunks – rolldown requires a function
        manualChunks: (id: string) => {
          if (id.includes('recharts') || id.includes('d3-') || id.includes('decimal.js')) {
            return 'chart-vendor';
          }
          if (id.includes('lucide-react')) {
            return 'ui-vendor';
          }
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/')) {
            return 'react-vendor';
          }
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
}))
