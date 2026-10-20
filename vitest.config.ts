import { defineConfig } from 'vitest/config';

// O vitest roda só os testes do backend. O teste do painel (frontend/tests) roda com `npm run test:painel`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
