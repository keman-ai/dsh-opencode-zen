import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";

//#region src/catalog.d.ts

/**
 * Bundled snapshot: the fallback list used when the upstream catalog is unreachable.
 *
 * **The normal path never reads this.** `discovery.ts` fetches free models live from
 * models.dev + Zen, because Zen states they are "time-limited, for vendor feedback" —
 * any hardcoded list is guaranteed to go stale. This snapshot only steps in when the
 * network is down or models.dev misbehaves, so an offline machine still sees a list
 * instead of nothing.
 *
 * Values copied from models.dev's `opencode` provider (verified 2026-08-18); all seven
 * models were `cost: 0` / `tool_call: true` / `reasoning: true` at the time.
 */
/** A catalog entry: model id plus display and capacity info. */
interface ZenModel {
  /** The `model` field sent to `/chat/completions`. */
  readonly id: string;
  /** Name shown in the model picker. */
  readonly name: string;
  /** One line to tell similar models apart. */
  readonly description: string;
  /** Context limit for request plus response, in tokens. */
  readonly contextWindow: number;
  /** Output cap for a single response, in tokens. */
  readonly maxOutputTokens: number;
}
/** The seven free models as of 2026-08-18, largest context first. */
declare const FALLBACK_MODELS: readonly ZenModel[];
/**
 * Find an entry by id in a catalog.
 * @param models - The current catalog (live or snapshot).
 * @param id - Model id.
 * @returns The matching entry, or undefined if absent — which does not mean
 *          unavailable; see the module comment.
 */
declare function findModel(models: readonly ZenModel[], id: string): ZenModel | undefined;
//#endregion
//#region src/discovery.d.ts

/** Catalog source, surfaced in logs so it is clear whether the user saw live data. */
type CatalogSource = 'live' | 'cache' | 'fallback';
interface CatalogResult {
  readonly models: readonly ZenModel[];
  readonly source: CatalogSource;
}
/** A models.dev entry; only the fields we use are declared. */
interface DevModel {
  id?: string;
  name?: string;
  description?: string;
  cost?: {
    input?: number;
    output?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
}
interface DevApi {
  opencode?: {
    models?: Record<string, DevModel>;
  };
}
interface DiscoveryOptions {
  /** models.dev full metadata URL. */
  readonly catalogUrl: string;
  /** Zen's model list URL (`${baseURL}/models`). */
  readonly modelsUrl: string;
  /** Catalog TTL. */
  readonly ttlMs: number;
  /** Timeout for a single upstream request. */
  readonly timeoutMs: number;
}
/**
 * Catalog service: one per plugin instance.
 *
 * Fetch failures **never throw** — a missing catalog should cost the picker a few entries, not stop a conversation whose model is already chosen.
 */
declare class Catalog {
  #private;
  /**
   * @param options - Upstream URLs and cache parameters.
   * @param now - Current-time source; injectable for tests.
   */
  constructor(options: DiscoveryOptions, now?: () => number);
  /**
   * The catalog as currently known, **without any network request**.
   *
   * For the request path: the model cap affects only the `max_tokens` field, and waiting
   * on a catalog fetch for it would add a network round trip to every turn. A cold cache
   * uses the snapshot.
   * @returns The cached catalog, or the bundled snapshot.
   */
  peek(): readonly ZenModel[];
  /**
   * Get the free-model catalog.
   * @param signal - The caller's abort signal.
   * @returns The catalog and its source. Never throws.
   */
  list(signal?: AbortSignal): Promise<CatalogResult>;
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
declare function freeModels(dev: DevApi, available?: ReadonlySet<string>): readonly ZenModel[];
//#endregion
//#region src/adapter.d.ts
/** Connection facts held by this adapter, read per request so config changes need no restart. */
interface ZenConnection {
  /** Endpoint root, including `/v1`. */
  readonly baseURL: string;
  /** Output cap per response. The model's own lower cap wins. */
  readonly maxTokens?: number;
  /** Context window used when the catalog has no entry for the model. */
  readonly defaultContextWindow: number;
}
/** Everything needed to construct the adapter. */
interface ZenAdapterOptions {
  /** Reads connection facts per request. */
  readonly options: () => ZenConnection;
  /**
   * Resolve the API key. **Returning undefined is allowed** — Zen's free models work
   * without a key, just on a shared, source-rate-limited quota. That is exactly why
   * this plugin works the moment it is installed.
   */
  readonly resolveApiKey: () => Promise<string | undefined>;
  /** Free-model catalog, fetched live with caching and a snapshot fallback. */
  readonly catalog: Catalog;
}
declare class ZenAdapter extends LlmAdapter {
  #private;
  constructor(options: ZenAdapterOptions);
  providerInfo(provider: string): LlmProviderInfo;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//#endregion
//#region src/index.d.ts
/** Plugin name (the `name` of the loader entry). */
declare const name = "opencode-zen";
/** Wait for the LLM service; without it this plugin is pointless. */
declare const inject: string[];
/** The provider route this plugin owns. */
declare const PROVIDER = "opencode-zen";
/** Zen's endpoint root — also what models.dev lists for the `opencode` provider. */
declare const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** Source of the free/paid verdict: Zen's own `/models` omits pricing. */
declare const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
/** Same credential variable opencode uses, so one key serves both. */
declare const DEFAULT_API_KEY_ENV = "OPENCODE_API_KEY";
/** Plugin config, all optional. Empty config means "anonymous access to free models". */
interface Config {
  /** Endpoint root, including `/v1`. Defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string;
  /**
   * Credential reference (an env var name), read per request. Defaults to
   * `OPENCODE_API_KEY`. **A missing key is not an error** — free models work
   * anonymously, just on a shared quota.
   */
  apiKeyEnv?: string;
  /** Where free-model metadata comes from. Defaults to {@link DEFAULT_CATALOG_URL}. */
  catalogUrl?: string;
  /** Catalog TTL in milliseconds. Defaults to one hour. */
  catalogTtlMs?: number;
  /** Catalog request timeout in milliseconds. Defaults to 8s. */
  catalogTimeoutMs?: number;
  /** Output cap per response. The model's own lower cap wins. */
  maxTokens?: number;
  /** Context window assumed when the catalog has no entry. Defaults to 128,000. */
  defaultContextWindow?: number;
}
/** Validate and complete the config. Out-of-range values fail here, not mid-request. */
declare function resolveConfig(config: Config): {
  connection: ZenConnection;
  apiKeyEnv: string;
  catalogUrl: string;
  catalogTtlMs: number;
  catalogTimeoutMs: number;
};
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Catalog, type CatalogResult, type CatalogSource, Config, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_CATALOG_URL, type DiscoveryOptions, FALLBACK_MODELS, PROVIDER, ZenAdapter, type ZenAdapterOptions, type ZenConnection, type ZenModel, apply, findModel, freeModels, inject, name, resolveConfig };