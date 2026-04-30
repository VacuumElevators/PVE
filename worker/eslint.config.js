import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Web Crypto + Fetch API globals provided by the Cloudflare Workers
        // runtime (and Node 20+, so local dev / vitest also resolves them).
        crypto: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', '**/*.test.js', '.wrangler/'],
  },
];
