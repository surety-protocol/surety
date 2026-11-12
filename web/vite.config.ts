import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
})
