/**
 * Registers OpenCode Zen's free models as a DeepSeek Harness provider route.
 *
 * Works with zero configuration: Zen's free models accept anonymous calls against
 * a shared, source-rate-limited quota. For a private quota, get a key at
 * https://opencode.ai/zen and set `OPENCODE_API_KEY` (same variable name opencode
 * uses, so one key serves both).
 *
 * The model list is not hardcoded — Zen states free models are time-limited, so
 * `discovery.ts` fetches it live from models.dev and Zen. The bundled snapshot is
 * only a fallback for when both are unreachable.
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

/** Plugin name (the `name` of the loader entry). */
export const name = 'opencode-zen'

/** Wait for the LLM service; without it this plugin is pointless. */
export const inject = ['llm']

/** The provider route this plugin owns. */
export const PROVIDER = 'opencode-zen'

/** Zen's endpoint root — also what models.dev lists for the `opencode` provider. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1'

/** Source of the free/paid verdict: Zen's own `/models` omits pricing. */
export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json'

/** Same credential variable opencode uses, so one key serves both. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'

/** Catalog TTL. The list changes on a weekly scale; an hour is fresh enough and gentle upstream. */
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000

/** Catalog request timeout. The catalog is an enhancement — fall back to the snapshot fast rather than stall the settings page. */
const DEFAULT_CATALOG_TIMEOUT_MS = 8000

/** Context window assumed when the catalog has no entry for a model. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Plugin config, all optional. Empty config means "anonymous access to free models". */
export interface Config {
  /** Endpoint root, including `/v1`. Defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /**
   * Credential reference (an env var name), read per request. Defaults to
   * `OPENCODE_API_KEY`. **A missing key is not an error** — free models work
   * anonymously, just on a shared quota.
   */
  apiKeyEnv?: string
  /** Where free-model metadata comes from. Defaults to {@link DEFAULT_CATALOG_URL}. */
  catalogUrl?: string
  /** Catalog TTL in milliseconds. Defaults to one hour. */
  catalogTtlMs?: number
  /** Catalog request timeout in milliseconds. Defaults to 8s. */
  catalogTimeoutMs?: number
  /** Output cap per response. The model's own lower cap wins. */
  maxTokens?: number
  /** Context window assumed when the catalog has no entry. Defaults to 128,000. */
  defaultContextWindow?: number
}

/** Validate and complete the config. Out-of-range values fail here, not mid-request. */
export function resolveConfig(config: Config): {
  connection: ZenConnection
  apiKeyEnv: string
  catalogUrl: string
  catalogTtlMs: number
  catalogTimeoutMs: number
} {
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('opencode-zen: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('opencode-zen: maxTokens must be a positive integer')
  }
  const catalogTtlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  if (!Number.isFinite(catalogTtlMs) || catalogTtlMs < 0) {
    throw new Error('opencode-zen: catalogTtlMs must be a non-negative number')
  }
  const catalogTimeoutMs = config.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
  if (!Number.isFinite(catalogTimeoutMs) || catalogTimeoutMs <= 0) {
    throw new Error('opencode-zen: catalogTimeoutMs must be a positive number')
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
   * Prefer the credentials service (where the web Models page stores the key);
   * without it, the env var is the whole credential surface. Neither present
   * returns undefined — an anonymous call.
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
    '[opencode-zen] registered provider %s (endpoint %s, credential env %s)',
    PROVIDER,
    resolved.connection.baseURL,
    resolved.apiKeyEnv,
  )
}
