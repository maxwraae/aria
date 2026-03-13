import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { transformSync } from 'esbuild';

// Pre-transform react-native-markdown-display JSX files for Rollup
const markdownDisplayJsxPlugin = {
  name: 'markdown-display-jsx',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (id.includes('react-native-markdown-display') && id.endsWith('.js')) {
      const result = transformSync(code, {
        loader: 'jsx',
        jsx: 'automatic',
        target: 'es2020',
      });
      return { code: result.code, map: null };
    }
  },
};

export default defineConfig({
  plugins: [
    markdownDisplayJsxPlugin,
    react(),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['react-native-markdown-display'],
    esbuildOptions: {
      jsx: 'automatic',
      loader: {
        '.js': 'jsx',
      },
    },
  },
});
