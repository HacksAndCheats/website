import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // ⚡ Minimize bundle size → faster page loads
    minify: 'esbuild',
    // Split vendor chunks so browser can cache them separately
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React — changes rarely, gets cached long-term
          'react-core': ['react', 'react-dom'],
          // UI icons — large, separate chunk
          'icons': ['lucide-react'],
          // Radix UI — large, separate chunk
          'radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-tooltip',
          ],
        },
        // Content-hash filenames → infinite cache lifetime
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // Increase chunk size warning limit (Radix UI is legitimately large)
    chunkSizeWarningLimit: 1000,
    // Target modern browsers for smaller, faster code
    target: 'esnext',
  },
  server: {
    port: 5173,
    // ⚡ Faster HMR in dev
    hmr: { overlay: true },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // ⚡ WebSocket proxy for terminal feature
        ws: true,
      },
    },
  },
  // ⚡ Pre-bundle heavy deps to reduce dev-mode waterfall requests
  optimizeDeps: {
    include: ['react', 'react-dom', 'lucide-react'],
  },
});
