import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        hmr: false
      }
    })
  ],
  test: {
    ssr: false,
    environment: 'jsdom',
    globals: true,
    aliasConditions: ['browser'],
    setupFiles: ['src/lib/test-utils/vitest-setup.ts'],
    // Ensure Svelte components compile for the browser (not SSR) during tests.
    // Without this, @testing-library/svelte sees server builds and `mount(...)` is unavailable.
    transformMode: { web: [/\.svelte$/] },
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '.svelte-kit/',
        'tests/',
        '**/*.config.*',
        '**/*.d.ts',
        '**/types.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '$lib': path.resolve('./src/lib'),
      '$app/environment': path.resolve('./src/lib/test-utils/app-environment-mock.ts'),
      '$app/stores': path.resolve('./src/lib/test-utils/app-stores-mock.ts'),
      '$app': path.resolve('./.svelte-kit/runtime/app'),
      '$env/dynamic/private': path.resolve('./src/lib/test-utils/env-mock.ts'),
      '$env/dynamic/public': path.resolve('./src/lib/test-utils/env-mock.ts'),
      // Force client runtime for Svelte when tests import components (avoids server-only mount errors).
      'svelte/internal/server': 'svelte/internal'
    },
    conditions: ['browser', 'development']
  },
  define: {
    'import.meta.env.SSR': false
  }
});
