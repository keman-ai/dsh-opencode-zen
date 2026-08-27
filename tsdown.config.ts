import { defineConfig } from 'tsdown'

/**
 * Bundle into a single ESM entry.
 *
 * All harness packages stay external: this plugin runs inside the harness process, so
 * `@deepseek-ai/dsh-llm` must resolve to the host's copy. Bundling it would create a
 * second `LlmAdapter` base class, breaking `instanceof` checks and service registration.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  dts: { sourcemap: false },
  external: [/^@deepseek-ai\//],
  clean: true,
  treeshake: true,
})
