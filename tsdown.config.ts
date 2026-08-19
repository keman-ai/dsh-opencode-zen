import { defineConfig } from 'tsdown'

/**
 * 打成一个 ESM 入口。
 *
 * harness 的包全部 external：本插件跑在 harness 进程内，`@deepseek-ai/dsh-llm`
 * 的实现必须解析到宿主那一份 —— 打进来会得到第二个 `LlmAdapter` 基类，
 * `instanceof` 判定和服务注册都会失效。
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
