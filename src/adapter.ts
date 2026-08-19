/**
 * OpenCode Zen 的 `LlmAdapter`：把 OpenAI 兼容的 `/chat/completions` 流翻译成
 * harness 的块序列。
 *
 * 两边对「流」的建模不同，这里的状态机就是为抹平这个差异而存在：
 * OpenAI 吐的是**扁平的增量**（`delta.content` / `delta.reasoning_content` /
 * `delta.tool_calls[i]`），harness 要的是**成对的块**（`block-start` → 若干
 * delta → `block-end` 带完整块）。所以适配器必须自己判断「一个块什么时候开始、
 * 什么时候结束」——上游从不明说。
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

/** 本适配器持有的连接事实，每次请求现取，改配置不必重启。 */
export interface ZenConnection {
  /** 端点根，含 `/v1`。 */
  readonly baseURL: string
  /** 单次响应的输出上限；模型自己的上限更小时以模型为准。 */
  readonly maxTokens?: number
  /** 目录里没有该模型时用的上下文容量。 */
  readonly defaultContextWindow: number
}

/** 构造适配器所需的一切。 */
export interface ZenAdapterOptions {
  /** 每次请求现取连接事实。 */
  readonly options: () => ZenConnection
  /**
   * 取 API key。**允许返回 undefined** —— Zen 的免费模型不带 key 也能调，
   * 只是走一个按来源限流的公共额度。这正是本插件装上就能用的原因。
   */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** 免费模型目录，从上游现拉并带缓存与快照兜底。 */
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
      // 目录是建议性的：没收录不等于不能用（Zen 会上新模型，而这张表是编译期常量）。
      // 给出配置里的默认容量，让上层的压缩策略仍有依据可用。
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
    // peek 而不是 list：目录只用来查模型自己的输出上限，不值得为它在每轮对话前
    // 多等一个网络往返。
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
        // 没有 key 就干脆不发这个头。发 `Bearer `（空值）会被部分网关判成
        // 「凭证格式错误」而 401，比匿名请求还糟。
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

/** 请求上限、部署上限、模型自身上限取最小；都没有就不发这个字段。 */
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
 * 把 HTTP 失败翻译成能照着做事的错误。
 *
 * 免费额度耗尽是本插件最常见的失败，而网关只回一句「Rate limit exceeded」，
 * 不说清「配个 key 就能继续」——这里补上，否则用户只会以为插件坏了。
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
    // 非 JSON 错误体（网关 502 的 HTML 页之类）就用原文截断。
  }

  if (response.status === 429) {
    const advice = hadKey
      ? '稍后重试，或在 https://opencode.ai/zen 查看该账号的免费额度'
      : '本插件当前在匿名调用 Zen，公共免费额度按来源限流；'
        + '到 https://opencode.ai/zen 取一个 key 并设进 OPENCODE_API_KEY 可获得独立额度'
    return new LlmError(
      `opencode-zen: 免费额度受限（${kind ?? 'rate limit'}）：${detail}。${advice}`,
      'RATE_LIMIT',
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      hadKey
        ? `opencode-zen: API key 被拒（HTTP ${response.status}）：${detail}`
        : `opencode-zen: 该请求需要凭证（HTTP ${response.status}）：${detail}。`
          + '到 https://opencode.ai/zen 取 key 并设进 OPENCODE_API_KEY',
      hadKey ? 'INVALID_CREDENTIAL' : 'MISSING_CREDENTIAL',
    )
  }
  return new LlmError(
    `opencode-zen: provider 返回 HTTP ${response.status}：${detail}`,
    'PROVIDER_ERROR',
  )
}
