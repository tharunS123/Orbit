import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript sources, so they are bundled in; npm dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@orbit\//],
  // Bundled CommonJS dependencies (e.g. web-push) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
