/**
 * 把 OpenCode Zen 的免费模型注册成 DeepSeek Harness 的一条 provider 路由。
 *
 * 装上不配任何东西就能用：Zen 的免费模型允许匿名调用，只是走一个按来源限流的
 * 公共额度。想要独立额度再去 https://opencode.ai/zen 取 key，设进
 * `OPENCODE_API_KEY`（这个变量名跟 opencode 官方一致，两边可以共用同一个 key）。
 *
 * 模型清单不写死在代码里 —— Zen 明说免费模型是限时提供，所以目录由
 * `discovery.ts` 从 models.dev 与 Zen 现拉，随包快照只在拉不到时兜底。
 *
 * @module dsh-opencode-zen
 */

import type { Context } from '@deepseek-ai/cordis'
import { ZenAdapter } from './adapter.ts'
import type { ZenConnection } from './adapter.ts'
import { Catalog } from './discovery.ts'

export { ZenAdapter } from './adapter.ts'
export type { ZenAdapterOptions, ZenConnection } from './adapter.ts'
export { Catalog, freeModels } from './discovery.ts'
export type { CatalogResult, CatalogSource, DiscoveryOptions } from './discovery.ts'
export { FALLBACK_MODELS, findModel } from './catalog.ts'
export type { ZenModel } from './catalog.ts'

/** 插件名（loader 行的 name）。 */
export const name = 'opencode-zen'

/** 等 LLM 服务就绪；没有它这个插件没有意义。 */
export const inject = ['llm']

/** 本插件拥有的那一条 provider 路由。 */
export const PROVIDER = 'opencode-zen'

/** Zen 的端点根。models.dev 上 `opencode` provider 登记的也是它。 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1'

/** 免费判定的数据源：Zen 自己的 `/models` 不返回价格，只能从这里看。 */
export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json'

/** 与 opencode 官方一致的凭证变量名，两边可共用一个 key。 */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'

/** 目录缓存时长：模型清单变化以周计，一小时足够新，也不会把上游打疼。 */
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000

/** 目录请求超时。目录是可有可无的增强，宁可快速回落到快照也不要卡住设置页。 */
const DEFAULT_CATALOG_TIMEOUT_MS = 8000

/** 目录里查不到该模型时假定的上下文容量。 */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** 插件配置，全部可选：什么都不写就是「匿名用免费模型」。 */
export interface Config {
  /** 端点根，含 `/v1`。默认 {@link DEFAULT_BASE_URL}。 */
  baseURL?: string
  /**
   * 凭证引用（环境变量名），每次请求现取；默认 `OPENCODE_API_KEY`。
   * **取不到不算错误** —— 免费模型匿名可用，只是额度按来源共享。
   */
  apiKeyEnv?: string
  /** 免费模型元数据来源。默认 {@link DEFAULT_CATALOG_URL}。 */
  catalogUrl?: string
  /** 目录缓存时长（毫秒），默认一小时。 */
  catalogTtlMs?: number
  /** 目录请求超时（毫秒），默认 8 秒。 */
  catalogTimeoutMs?: number
  /** 单次响应输出上限；模型自身上限更小时以模型为准。 */
  maxTokens?: number
  /** 目录查不到该模型时假定的上下文容量，默认 128,000。 */
  defaultContextWindow?: number
}

/** 校验并补全配置。越界一律在这里失败，而不是等到发请求时才炸。 */
export function resolveConfig(config: Config): {
  connection: ZenConnection
  apiKeyEnv: string
  catalogUrl: string
  catalogTtlMs: number
  catalogTimeoutMs: number
} {
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('opencode-zen: defaultContextWindow 必须是正整数')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('opencode-zen: maxTokens 必须是正整数')
  }
  const catalogTtlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  if (!Number.isFinite(catalogTtlMs) || catalogTtlMs < 0) {
    throw new Error('opencode-zen: catalogTtlMs 必须是非负数')
  }
  const catalogTimeoutMs = config.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
  if (!Number.isFinite(catalogTimeoutMs) || catalogTimeoutMs <= 0) {
    throw new Error('opencode-zen: catalogTimeoutMs 必须是正数')
  }
  return {
    connection: {
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
      defaultContextWindow,
    },
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    catalogUrl: config.catalogUrl ?? DEFAULT_CATALOG_URL,
    catalogTtlMs,
    catalogTimeoutMs,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const catalog = new Catalog({
    catalogUrl: resolved.catalogUrl,
    modelsUrl: `${resolved.connection.baseURL.replace(/\/+$/, '')}/models`,
    ttlMs: resolved.catalogTtlMs,
    timeoutMs: resolved.catalogTimeoutMs,
  })

  /**
   * 凭证优先走 credentials 服务（网页「模型」页写进去的 key 在那儿），
   * 没有这个服务时环境变量就是全部的凭证面。两处都没有就返回 undefined —— 匿名调用。
   */
  const resolveApiKey = async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(resolved.apiKeyEnv)
      if (hit !== undefined && hit.value.length > 0) {
        return hit.value
      }
    }
    const ambient = process.env[resolved.apiKeyEnv]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  const adapter = new ZenAdapter({ options: () => resolved.connection, resolveApiKey, catalog })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), `opencode-zen: ${PROVIDER}`)

  ctx.logger.info(
    '[opencode-zen] 已注册 provider %s（端点 %s，凭证变量 %s）',
    PROVIDER,
    resolved.connection.baseURL,
    resolved.apiKeyEnv,
  )
}
