/**
 * Free-model catalog discovery: fetched live from upstream instead of welded into the code.
 *
 * Why two sources:
 * - `https://opencode.ai/zen/v1/models` returns only `{id, object, created, owned_by}` —
 *   **no pricing**, so it alone cannot tell which models are free;
 * - `https://models.dev/api.json`'s `opencode` section has `cost` and `limit` (the same
 *   data opencode itself reads), but it is a community mirror and can lag the gateway.
 *
 * Hence the rule: **models.dev decides which are free and how large; zen decides which
 * still exist.** With both, intersect them; without zen, trust models.dev alone; with
 * neither, fall back to the bundled snapshot.
 *
 * The catalog is always **advisory**: the harness allows requesting an unlisted model id,
 * so staleness or gaps block nobody — at worst the picker shows fewer entries, and a
 * hand-typed id still works.
 */

import { FALLBACK_MODELS } from './catalog.ts'
import type { ZenModel } from './catalog.ts'

/** Catalog source, surfaced in logs so it is clear whether the user saw live data. */
export type CatalogSource = 'live' | 'cache' | 'fallback'

export interface CatalogResult {
  readonly models: readonly ZenModel[]
  readonly source: CatalogSource
}

/** A models.dev entry; only the fields we use are declared. */
interface DevModel {
  id?: string
  name?: string
  description?: string
  cost?: { input?: number, output?: number }
  limit?: { context?: number, output?: number }
}

interface DevApi {
  opencode?: { models?: Record<string, DevModel> }
}

interface ZenModelList {
  data?: { id?: string }[]
}

export interface DiscoveryOptions {
  /** models.dev full metadata URL. */
  readonly catalogUrl: string
  /** Zen's model list URL (`${baseURL}/models`). */
  readonly modelsUrl: string
  /** Catalog TTL. */
  readonly ttlMs: number
  /** Timeout for a single upstream request. */
  readonly timeoutMs: number
}

interface CacheRow {
  readonly at: number
  readonly models: readonly ZenModel[]
}

/**
 * Catalog service: one per plugin instance.
 *
 * Fetch failures **never throw** — a missing catalog should cost the picker a few entries, not stop a conversation whose model is already chosen.
 */
export class Catalog {
  #cache: CacheRow | undefined
  /** In-flight fetch, for deduplication: opening the settings page asks several times at once. */
  #inflight: Promise<readonly ZenModel[]> | undefined
  #lastFailureAt = 0

  readonly #options: DiscoveryOptions
  readonly #now: () => number

  /**
   * @param options - Upstream URLs and cache parameters.
   * @param now - Current-time source; injectable for tests.
   */
  constructor(options: DiscoveryOptions, now: () => number = Date.now) {
    // No constructor parameter properties: Node's type stripping only erases, never emits,
    // and parameter properties would need generated assignments — `node --test *.ts`
    // fails with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
    this.#options = options
    this.#now = now
  }

  /**
   * The catalog as currently known, **without any network request**.
   *
   * For the request path: the model cap affects only the `max_tokens` field, and waiting
   * on a catalog fetch for it would add a network round trip to every turn. A cold cache
   * uses the snapshot.
   * @returns The cached catalog, or the bundled snapshot.
   */
  peek(): readonly ZenModel[] {
    return this.#cache?.models ?? FALLBACK_MODELS
  }

  /**
   * Get the free-model catalog.
   * @param signal - The caller's abort signal.
   * @returns The catalog and its source. Never throws.
   */
  async list(signal?: AbortSignal): Promise<CatalogResult> {
    const cached = this.#cache
    if (cached !== undefined && this.#now() - cached.at < this.#options.ttlMs) {
      return { models: cached.models, source: 'cache' }
    }
    // Back off after a recent failure: one settings refresh asks repeatedly, and offline that would become a run of timeouts.
    if (this.#now() - this.#lastFailureAt < this.#options.timeoutMs) {
      return { models: cached?.models ?? FALLBACK_MODELS, source: cached === undefined ? 'fallback' : 'cache' }
    }

    this.#inflight ??= this.#fetchAll(signal).finally(() => {
      this.#inflight = undefined
    })
    const models = await this.#inflight
    if (models.length === 0) {
      this.#lastFailureAt = this.#now()
      return { models: cached?.models ?? FALLBACK_MODELS, source: cached === undefined ? 'fallback' : 'cache' }
    }
    this.#cache = { at: this.#now(), models }
    return { models, source: 'live' }
  }

  async #fetchAll(signal?: AbortSignal): Promise<readonly ZenModel[]> {
    const [dev, live] = await Promise.all([
      this.#json<DevApi>(this.#options.catalogUrl, signal),
      this.#json<ZenModelList>(this.#options.modelsUrl, signal),
    ])
    if (dev === undefined) {
      return []
    }
    const available = liveIds(live)
    return freeModels(dev, available)
  }

  async #json<T>(url: string, signal?: AbortSignal): Promise<T | undefined> {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(this.#options.timeoutMs),
      })
      if (!response.ok) {
        return undefined
      }
      return await response.json() as T
    } catch {
      // The catalog is an optional enhancement: any failure falls back to the snapshot silently.
      return undefined
    }
  }
}

/** The ids Zen currently offers; undefined when unavailable — meaning "unconfirmed", not "empty". */
function liveIds(list: ZenModelList | undefined): ReadonlySet<string> | undefined {
  const ids = list?.data?.map(entry => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids === undefined || ids.length === 0 ? undefined : new Set(ids)
}

/**
 * Select the free models from models.dev's opencode section.
 *
 * The test is `cost.input === 0 && cost.output === 0`, not the id's `-free` suffix —
 * the suffix is a naming habit (`big-pickle` has none); price is the fact.
 *
 * @param dev - The models.dev response.
 * @param available - Ids Zen currently offers; undefined means that source failed, so no filtering.
 * @returns The catalog, largest context first.
 */
export function freeModels(dev: DevApi, available?: ReadonlySet<string>): readonly ZenModel[] {
  const models = dev.opencode?.models
  if (models === undefined) {
    return []
  }
  const out: ZenModel[] = []
  for (const [key, model] of Object.entries(models)) {
    const id = model.id ?? key
    if (model.cost?.input !== 0 || model.cost?.output !== 0) {
      continue
    }
    if (available !== undefined && !available.has(id)) {
      // Still on models.dev but already withdrawn by the gateway — the eventual fate of every time-limited free model.
      continue
    }
    const context = model.limit?.context
    const output = model.limit?.output
    if (typeof context !== 'number' || context <= 0) {
      continue
    }
    out.push({
      id,
      name: model.name ?? id,
      description: model.description ?? '',
      contextWindow: context,
      maxOutputTokens: typeof output === 'number' && output > 0 ? output : context,
    })
  }
  // Largest first: the wall people hit most often when picking a free model is context size.
  return out.sort((a, b) => b.contextWindow - a.contextWindow)
}
