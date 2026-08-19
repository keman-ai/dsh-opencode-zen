import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";

//#region src/catalog.d.ts

/**
 * 随包快照：上游目录拉不到时用的兜底清单。
 *
 * **正常路径不读这里** —— 免费模型由 `discovery.ts` 从 models.dev + zen 现拉，
 * 因为 Zen 明说免费模型是「限时提供、供厂商收集反馈」，写死的清单必然过期。
 * 这份快照只在断网、models.dev 挂掉或返回异常时顶上，让插件在没有网络的机器上
 * 仍然有个可选列表，而不是空白。
 *
 * 数值抄自 models.dev 的 `opencode` provider（2026-08-18 核对），七个模型当时
 * 全部 `cost: 0` / `tool_call: true` / `reasoning: true`。
 */
/** 一条目录项：模型 id 加上展示与容量信息。 */
interface ZenModel {
  /** 传给 `/chat/completions` 的 `model` 字段。 */
  readonly id: string;
  /** 选择器里显示的名字。 */
  readonly name: string;
  /** 一句话区分同类模型。 */
  readonly description: string;
  /** 请求加响应的上下文上限（token）。 */
  readonly contextWindow: number;
  /** 单次响应的输出上限（token）。 */
  readonly maxOutputTokens: number;
}
/** 2026-08-18 那天的七个免费模型，按上下文容量从大到小排。 */
declare const FALLBACK_MODELS: readonly ZenModel[];
/**
 * 在一份目录里按 id 找条目。
 * @param models - 当前目录（实时或快照）。
 * @param id - 模型 id。
 * @returns 命中的条目；未收录时 undefined —— 不代表不可用，见模块注释。
 */
declare function findModel(models: readonly ZenModel[], id: string): ZenModel | undefined;
//#endregion
//#region src/discovery.d.ts

/** 目录来源，出现在日志里，便于判断用户看到的是不是实时数据。 */
type CatalogSource = 'live' | 'cache' | 'fallback';
interface CatalogResult {
  readonly models: readonly ZenModel[];
  readonly source: CatalogSource;
}
/** models.dev 的模型条目，只声明用到的字段。 */
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
  /** models.dev 全量元数据地址。 */
  readonly catalogUrl: string;
  /** zen 的模型列表地址（`${baseURL}/models`）。 */
  readonly modelsUrl: string;
  /** 目录缓存时长。 */
  readonly ttlMs: number;
  /** 单次上游请求超时。 */
  readonly timeoutMs: number;
}
/**
 * 目录服务：一个插件实例一个。
 *
 * 拉取失败**不抛**——目录拉不到只该让选择器少几项，不该让已经选好模型的对话发不出去。
 */
declare class Catalog {
  #private;
  /**
   * @param options - 上游地址与缓存参数。
   * @param now - 取当前时间，测试可注入。
   */
  constructor(options: DiscoveryOptions, now?: () => number);
  /**
   * 当前已知的目录，**不发网络请求**。
   *
   * 给发请求那条路径用：模型上限只影响 `max_tokens` 这一个字段，为它去等一次
   * 目录拉取，等于给每轮对话平白加一个网络往返。缓存没热就用快照。
   * @returns 缓存目录，或随包快照。
   */
  peek(): readonly ZenModel[];
  /**
   * 取免费模型目录。
   * @param signal - 调用方的取消信号。
   * @returns 目录与它的来源；永不抛。
   */
  list(signal?: AbortSignal): Promise<CatalogResult>;
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
declare function freeModels(dev: DevApi, available?: ReadonlySet<string>): readonly ZenModel[];
//#endregion
//#region src/adapter.d.ts
/** 本适配器持有的连接事实，每次请求现取，改配置不必重启。 */
interface ZenConnection {
  /** 端点根，含 `/v1`。 */
  readonly baseURL: string;
  /** 单次响应的输出上限；模型自己的上限更小时以模型为准。 */
  readonly maxTokens?: number;
  /** 目录里没有该模型时用的上下文容量。 */
  readonly defaultContextWindow: number;
}
/** 构造适配器所需的一切。 */
interface ZenAdapterOptions {
  /** 每次请求现取连接事实。 */
  readonly options: () => ZenConnection;
  /**
   * 取 API key。**允许返回 undefined** —— Zen 的免费模型不带 key 也能调，
   * 只是走一个按来源限流的公共额度。这正是本插件装上就能用的原因。
   */
  readonly resolveApiKey: () => Promise<string | undefined>;
  /** 免费模型目录，从上游现拉并带缓存与快照兜底。 */
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
/** 插件名（loader 行的 name）。 */
declare const name = "opencode-zen";
/** 等 LLM 服务就绪；没有它这个插件没有意义。 */
declare const inject: string[];
/** 本插件拥有的那一条 provider 路由。 */
declare const PROVIDER = "opencode-zen";
/** Zen 的端点根。models.dev 上 `opencode` provider 登记的也是它。 */
declare const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** 免费判定的数据源：Zen 自己的 `/models` 不返回价格，只能从这里看。 */
declare const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
/** 与 opencode 官方一致的凭证变量名，两边可共用一个 key。 */
declare const DEFAULT_API_KEY_ENV = "OPENCODE_API_KEY";
/** 插件配置，全部可选：什么都不写就是「匿名用免费模型」。 */
interface Config {
  /** 端点根，含 `/v1`。默认 {@link DEFAULT_BASE_URL}。 */
  baseURL?: string;
  /**
   * 凭证引用（环境变量名），每次请求现取；默认 `OPENCODE_API_KEY`。
   * **取不到不算错误** —— 免费模型匿名可用，只是额度按来源共享。
   */
  apiKeyEnv?: string;
  /** 免费模型元数据来源。默认 {@link DEFAULT_CATALOG_URL}。 */
  catalogUrl?: string;
  /** 目录缓存时长（毫秒），默认一小时。 */
  catalogTtlMs?: number;
  /** 目录请求超时（毫秒），默认 8 秒。 */
  catalogTimeoutMs?: number;
  /** 单次响应输出上限；模型自身上限更小时以模型为准。 */
  maxTokens?: number;
  /** 目录查不到该模型时假定的上下文容量，默认 128,000。 */
  defaultContextWindow?: number;
}
/** 校验并补全配置。越界一律在这里失败，而不是等到发请求时才炸。 */
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