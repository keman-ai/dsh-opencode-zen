# dsh-opencode-zen

把 [OpenCode Zen](https://opencode.ai/zen) 的**免费模型**接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

装上不用配任何东西——Zen 的免费模型允许匿名调用，插件启动就能在模型列表里选到它们。

```
模型选择器
├─ nemotron-3-ultra-free         100 万上下文
├─ nemotron-3.5-lightning-free   26 万上下文，输出也是 26 万
├─ laguna-s-2.1-free             25.6 万上下文
├─ deepseek-v4-flash-free        20 万上下文，12.8 万输出
├─ big-pickle                    Zen 自家的匿名评测模型
├─ mimo-v2.5-free                20 万上下文
└─ hy3-free                      19 万上下文
```

这份清单**不写在代码里**，是运行时从上游拉的（见下）。七个模型全部支持工具调用和推理内容，够跑完整的 agent 循环。

## 安装

```sh
dsh plugin --profile web add dsh-opencode-zen
```

或者在 profile 的 `cordis.yml` 里直接写一行：

```yaml
plugins:
  dsh-opencode-zen:
```

装完重启一次 dsh，模型选择器里就会出现 `opencode-zen` 这一组。

## 要不要 API key

**不要也能用。** 匿名调用走 Zen 的公共免费额度，按来源限流——一个人试试够了，跑量会撞到 `FreeUsageLimitError`。

想要独立额度就去 [opencode.ai/zen](https://opencode.ai/zen) 取一个 key：

```sh
export OPENCODE_API_KEY=<你的 key>
```

变量名跟 opencode 官方一致，所以你如果本来就在用 opencode，两边共用同一个 key 即可。也可以在 dsh 网页的「模型」页里存进凭证服务，插件会优先读那里。

额度用尽时插件不会只丢一句「Rate limit exceeded」，而是告诉你当前是匿名还是带 key，以及下一步能做什么。

## 免费清单为什么是动态的

Zen 明说免费模型是**限时提供**、供厂商收集反馈的，写死的清单迟早过期。所以插件在运行时合并两个数据源：

| 数据源 | 提供什么 | 为什么不能只用它 |
|---|---|---|
| [models.dev](https://models.dev/api.json) 的 `opencode` 段 | 价格、上下文与输出上限、名称描述 | 社区维护的镜像，可能比网关落后 |
| `https://opencode.ai/zen/v1/models` | 当前真实在售的模型 id | **不返回价格**，分不出免费付费 |

判定规则是 **models.dev 定「哪些免费、多大上下文」，Zen 定「现在还有没有」**，取交集。免费的判据是 `cost.input === 0 && cost.output === 0`，不是 id 有没有 `-free` 后缀——`big-pickle` 就没有后缀但确实免费。

目录缓存一小时。两个源都拉不到时回落到随包快照（2026-08-18 那天的七个），断网也不会让选择器空白。

目录始终是**建议性**的：harness 允许请求未列出的模型 id，所以清单落后或缺失不会挡住任何人，手填 id 照样能用。

## 配置

全部可选，什么都不写就是上面描述的默认行为。

```yaml
plugins:
  dsh-opencode-zen:
    apiKeyEnv: OPENCODE_API_KEY        # 凭证引用（环境变量名）
    baseURL: https://opencode.ai/zen/v1
    catalogUrl: https://models.dev/api.json
    catalogTtlMs: 3600000              # 目录缓存时长，默认一小时
    catalogTimeoutMs: 8000             # 目录请求超时
    maxTokens: 32000                   # 输出上限；模型自身上限更小时以模型为准
    defaultContextWindow: 128000       # 目录里查不到该模型时假定的容量
```

## 已知边界

- **免费额度是共享的**。匿名调用尤其容易撞限流，这是 Zen 的策略，插件只能把原因说清楚。
- **不回传推理内容**。OpenAI 兼容的 `chat/completions` 没有承载上一轮思考的请求字段，各家对此的处理也互不兼容，所以推理块只展示、不回灌。
- **纯文本**。七个模型的 `modalities.input` 都只有 text，工具结果里的图片会被替换成一行占位说明，而不是静默丢掉。
- **付费模型不进目录**。Zen 也提供 Claude、GPT 等付费模型，但本插件存在的理由就是「不配任何东西也能先跑起来」，把两类混在一个列表里会让人分不清点哪个要花钱。要用付费模型，配一个指向同一端点的 `llm-deepseek` 条目即可（它是 OpenAI 兼容适配器，`baseURL` 可配）。

## 开发

```sh
pnpm install
pnpm check      # 类型检查
pnpm test       # 单元测试
pnpm build      # 打包到 lib/
```

代码分成四层，都可以单独测：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：配置校验、凭证解析、往 `ctx.llm` 注册 provider |
| `src/adapter.ts` | `LlmAdapter` 实现：发请求、映射错误、暴露模型元数据 |
| `src/stream.ts` | SSE 增量 → harness 块序列的状态机（只依赖类型，可脱离 harness 测） |
| `src/discovery.ts` | 免费目录的双源合并、缓存与兜底 |

`types/dsh.d.ts` 自带了用到的那部分 harness API 声明，照 `0.1.0-rc.7` 的源码抄写。**不依赖 npm 上的 `@deepseek-ai/dsh-llm`**——那个包停在 `0.0.1-rc.1`，与当前 harness 的类型对不上。这些模块运行时全是 external，实现由跑着本插件的 harness 进程提供。宿主行为与声明对不上时，先回那个文件核对。

## 相关

- [OpenCode Zen](https://opencode.ai/zen) —— 模型网关本体，key 在这里取
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 宿主
- [dsh-skin-market](https://github.com/keman-ai/dsh-skin-market) —— 同一批人做的皮肤市场插件

## 许可

[MIT](LICENSE) © 2026 Science Roam Limited
