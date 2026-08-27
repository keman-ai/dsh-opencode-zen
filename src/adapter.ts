/**
 * The `LlmAdapter` for OpenCode Zen: translates an OpenAI-compatible
 * `/chat/completions` stream into the harness block sequence.
 *
 * The two sides model "a stream" differently, and this state machine exists to bridge
 * that: OpenAI emits **flat deltas** (`delta.content` / `delta.reasoning_content` /
 * `delta.tool_calls[i]`), while the harness wants **paired blocks** (`block-start` →
 * deltas → `block-end` carrying the full block). So the adapter must decide when a
 * block starts and ends — upstream never says.
 */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { findModel } from './catalog.ts'
import type { Catalog } from './discovery.ts'
import { toWireMessages, toWireTools } from './translate.ts'
import { consume } from './stream.ts'
import type { WireError, WireRequest } from './wire.ts'

/** Connection facts held by this adapter, read per request so config changes need no restart. */
export interface ZenConnection {
  /** Endpoint root, including `/v1`. */
  readonly baseURL: string
  /** Output cap per response. The model's own lower cap wins. */
  readonly maxTokens?: number
  /** Context window used when the catalog has no entry for the model. */
  readonly defaultContextWindow: number
}

/** Everything needed to construct the adapter. */
export interface ZenAdapterOptions {
  /** Reads connection facts per request. */
  readonly options: () => ZenConnection
  /**
   * Resolve the API key. **Returning undefined is allowed** — Zen's free models work
   * without a key, just on a shared, source-rate-limited quota. That is exactly why
   * this plugin works the moment it is installed.
   */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** Free-model catalog, fetched live with caching and a snapshot fallback. */
  readonly catalog: Catalog
}

export class ZenAdapter extends LlmAdapter {
  readonly #options: ZenAdapterOptions['options']
  readonly #resolveApiKey: ZenAdapterOptions['resolveApiKey']
  readonly #catalog: Catalog

  constructor(options: ZenAdapterOptions) {
    super()
    this.#options = options.options
    this.#resolveApiKey = options.resolveApiKey
    this.#catalog = options.catalog
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode Zen' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const { models } = await this.#catalog.list()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const { models } = await this.#catalog.list(signal)
    const known = findModel(models, model)
    const connection = this.#options()
    if (known === undefined) {
      // The catalog is advisory: absence does not mean unusable (Zen adds models, and this
      // table is a compile-time constant). Fall back to the configured default so the
      // layer above still has a number to base compaction on.
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: connection.defaultContextWindow },
      }
    }
    return {
      provider,
      id: known.id,
      name: known.name,
      description: known.description,
      context: {
        contextWindow: known.contextWindow,
        maxOutputTokens: known.maxOutputTokens,
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options()
    const apiKey = await this.#resolveApiKey()
    // peek, not list: the catalog is only consulted for the model's own output cap —
    // not worth an extra network round trip before every turn.
    const model = findModel(this.#catalog.peek(), options.model)

    const body: WireRequest = {
      model: options.model,
      messages: toWireMessages(options.messages, options.system),
      stream: true,
      stream_options: { include_usage: true },
    }
    const tools = toWireTools(options.tools)
    if (tools !== undefined) {
      body.tools = tools
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }
    const maxTokens = resolveMaxTokens(options.maxTokens, connection.maxTokens, model?.maxOutputTokens)
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens
    }
    if (options.stop !== undefined && options.stop.length > 0) {
      body.stop = [...options.stop]
    }

    const response = await fetch(`${trimSlash(connection.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...attributionHeaders(),
        // With no key, omit the header entirely. Sending `Bearer ` (empty) makes some
        // gateways return 401 for a malformed credential — worse than an anonymous call.
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      },
      body: JSON.stringify(body),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })

    if (!response.ok) {
      throw await describeFailure(response, apiKey !== undefined)
    }
    if (response.body === null) {
      throw new LlmError('opencode-zen: provider returned no response body', 'PROVIDER_ERROR')
    }

    yield* consume(response.body)
  }
}

/** Take the minimum of request cap, deployment cap and the model's own cap; omit the field if none exist. */
function resolveMaxTokens(
  requested: number | undefined,
  configured: number | undefined,
  modelCap: number | undefined,
): number | undefined {
  const candidates = [requested, configured, modelCap].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
  return candidates.length === 0 ? undefined : Math.min(...candidates)
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Translate an HTTP failure into an error the user can act on.
 *
 * Exhausted free quota is this plugin's most common failure, and the gateway only says
 * "Rate limit exceeded" without mentioning that a key would unblock it. We add that
 * here; otherwise users just conclude the plugin is broken.
 */
async function describeFailure(response: Response, hadKey: boolean): Promise<LlmError> {
  const raw = await response.text().catch(() => '')
  let detail = raw.slice(0, 500)
  let kind: string | undefined
  try {
    const parsed = JSON.parse(raw) as WireError
    kind = parsed.error?.type
    detail = parsed.error?.message ?? parsed.message ?? detail
  } catch {
    // Non-JSON error bodies (a gateway's 502 HTML page, say) are truncated verbatim.
  }

  if (response.status === 429) {
    const advice = hadKey
      ? 'Retry later, or check this account\'s free quota at https://opencode.ai/zen'
      : 'This plugin is calling Zen anonymously; the shared free quota is rate-limited by '
        + 'source. Get a key at https://opencode.ai/zen and set OPENCODE_API_KEY for a private quota'
    return new LlmError(
      `opencode-zen: free quota limited (${kind ?? 'rate limit'}): ${detail}. ${advice}`,
      'RATE_LIMIT',
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      hadKey
        ? `opencode-zen: API key rejected (HTTP ${response.status}): ${detail}`
        : `opencode-zen: this request needs a credential (HTTP ${response.status}): ${detail}. `
          + 'Get a key at https://opencode.ai/zen and set OPENCODE_API_KEY',
      hadKey ? 'INVALID_CREDENTIAL' : 'MISSING_CREDENTIAL',
    )
  }
  return new LlmError(
    `opencode-zen: provider returned HTTP ${response.status}: ${detail}`,
    'PROVIDER_ERROR',
  )
}
