/**
 * 免费模型目录的发现：从上游现拉，而不是把清单焊死在代码里。
 *
 * 为什么要两个数据源：
 * - `https://opencode.ai/zen/v1/models` 只回 `{id, object, created, owned_by}`，
 *   **没有价格**，光靠它分不出哪些免费；
 * - `https://models.dev/api.json` 的 `opencode` 段有 `cost` 和 `limit`（opencode
 *   自己读的也是这份），但它是社区维护的镜像，可能比网关落后。
 *
 * 所以判定是：**models.dev 定「哪些免费、多大上下文」，zen 定「现在还有没有」**。
 * 两边都拿到就取交集；zen 那边拿不到就只信 models.dev；都拿不到才回落到随包快照。
 *
 * 目录始终是**建议性**的：harness 允许请求未列出的模型 id，所以这里的过期或缺失
 * 不会挡住任何人——最坏情况是选择器里少几个条目，手填 id 照样能用。
 */

import { FALLBACK_MODELS } from './catalog.ts'
import type { ZenModel } from './catalog.ts'

/** 目录来源，出现在日志里，便于判断用户看到的是不是实时数据。 */
export type CatalogSource = 'live' | 'cache' | 'fallback'

export interface CatalogResult {
  readonly models: readonly ZenModel[]
  readonly source: CatalogSource
}

/** models.dev 的模型条目，只声明用到的字段。 */
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
  /** models.dev 全量元数据地址。 */
  readonly catalogUrl: string
  /** zen 的模型列表地址（`${baseURL}/models`）。 */
  readonly modelsUrl: string
  /** 目录缓存时长。 */
  readonly ttlMs: number
  /** 单次上游请求超时。 */
  readonly timeoutMs: number
}

interface CacheRow {
  readonly at: number
  readonly models: readonly ZenModel[]
}

/**
 * 目录服务：一个插件实例一个。
 *
 * 拉取失败**不抛**——目录拉不到只该让选择器少几项，不该让已经选好模型的对话发不出去。
 */
export class Catalog {
  #cache: CacheRow | undefined
  /** 进行中的拉取，用于并发去重：设置页一打开会同时问好几次。 */
  #inflight: Promise<readonly ZenModel[]> | undefined
  #lastFailureAt = 0

  readonly #options: DiscoveryOptions
  readonly #now: () => number

  /**
   * @param options - 上游地址与缓存参数。
   * @param now - 取当前时间，测试可注入。
   */
  constructor(options: DiscoveryOptions, now: () => number = Date.now) {
    // 不用构造器参数属性：Node 的类型剥离是「只删不生成」，参数属性要生成赋值语句，
    // 直接 `node --test *.ts` 会以 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 失败。
    this.#options = options
    this.#now = now
  }

  /**
   * 当前已知的目录，**不发网络请求**。
   *
   * 给发请求那条路径用：模型上限只影响 `max_tokens` 这一个字段，为它去等一次
   * 目录拉取，等于给每轮对话平白加一个网络往返。缓存没热就用快照。
   * @returns 缓存目录，或随包快照。
   */
  peek(): readonly ZenModel[] {
    return this.#cache?.models ?? FALLBACK_MODELS
  }

  /**
   * 取免费模型目录。
   * @param signal - 调用方的取消信号。
   * @returns 目录与它的来源；永不抛。
   */
  async list(signal?: AbortSignal): Promise<CatalogResult> {
    const cached = this.#cache
    if (cached !== undefined && this.#now() - cached.at < this.#options.ttlMs) {
      return { models: cached.models, source: 'cache' }
    }
    // 刚失败过就先别再打：设置页刷新一次会连着问，断网时不该变成一串超时。
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
      // 目录是可有可无的增强，任何失败都退回快照，不惊动调用方。
      return undefined
    }
  }
}

/** zen 当前在售的 id 集合；拿不到时 undefined（表示「无法确认」，不是「空」）。 */
function liveIds(list: ZenModelList | undefined): ReadonlySet<string> | undefined {
  const ids = list?.data?.map(entry => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids === undefined || ids.length === 0 ? undefined : new Set(ids)
}

/**
 * 从 models.dev 的 opencode 段筛出免费模型。
 *
 * 判据是 `cost.input === 0 && cost.output === 0`，不是 id 的 `-free` 后缀 ——
 * 后缀是命名习惯（`big-pickle` 就没有），价格才是事实。
 *
 * @param dev - models.dev 响应。
 * @param available - zen 当前在售的 id；undefined 表示这一路没拿到，不做过滤。
 * @returns 按上下文容量降序的目录。
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
      // models.dev 还留着，但网关已经下架了——限时免费的模型迟早走这条路。
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
  // 容量大的排前面：选免费模型的人最常撞到的墙是上下文不够。
  return out.sort((a, b) => b.contextWindow - a.contextWindow)
}
