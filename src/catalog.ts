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
export interface ZenModel {
  /** 传给 `/chat/completions` 的 `model` 字段。 */
  readonly id: string
  /** 选择器里显示的名字。 */
  readonly name: string
  /** 一句话区分同类模型。 */
  readonly description: string
  /** 请求加响应的上下文上限（token）。 */
  readonly contextWindow: number
  /** 单次响应的输出上限（token）。 */
  readonly maxOutputTokens: number
}

/** 2026-08-18 那天的七个免费模型，按上下文容量从大到小排。 */
export const FALLBACK_MODELS: readonly ZenModel[] = [
  {
    id: 'nemotron-3-ultra-free',
    name: 'Nemotron 3 Ultra (free)',
    description: '百万上下文，长仓库通读的首选',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning (free)',
    description: '输出上限与上下文一样大，适合长篇生成',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
  },
  {
    id: 'laguna-s-2.1-free',
    name: 'Laguna S 2.1 (free)',
    description: '25.6 万上下文的通用款',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
  },
  {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash (free)',
    description: '与 harness 同源的 DeepSeek，12.8 万输出',
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'big-pickle',
    name: 'Big Pickle (free)',
    description: 'Zen 自家的匿名评测模型',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: 'mimo-v2.5-free',
    name: 'MiMo v2.5 (free)',
    description: '20 万上下文的轻量款',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: 'hy3-free',
    name: 'HY3 (free)',
    description: '19 万上下文，6.4 万输出',
    contextWindow: 190_000,
    maxOutputTokens: 64_000,
  },
]

/**
 * 在一份目录里按 id 找条目。
 * @param models - 当前目录（实时或快照）。
 * @param id - 模型 id。
 * @returns 命中的条目；未收录时 undefined —— 不代表不可用，见模块注释。
 */
export function findModel(models: readonly ZenModel[], id: string): ZenModel | undefined {
  return models.find(model => model.id === id)
}
