/**
 * 用到的那部分 DeepSeek Harness API 声明，照 `0.1.0-rc.7` 的源码抄写，每处标了出处。
 *
 * 为什么自带而不是依赖 npm 包：npm 上的 `@deepseek-ai/dsh-llm` 停在 `0.0.1-rc.1`，
 * 与当前 harness（`0.1.0-rc.7`）的类型对不上，装下来反而编译不过。这些模块运行时
 * 全是 external —— 真正提供实现的是跑着本插件的那个 harness 进程，`LlmAdapter`
 * 和 `attributionHeaders` 都要在运行时真的解析到宿主的实现。
 *
 * 宿主行为与这里的声明对不上时，先回 harness 源码核对，别改代码去迁就声明。
 */

declare module '@deepseek-ai/cordis' {
  /** cordis Logger 门面是 `Record<'error'|'info'|'warn'|'debug', LoggerMethod>`，这里按用到的列。 */
  export interface Logger {
    info(message: unknown, ...args: readonly unknown[]): void
    warn(message: unknown, ...args: readonly unknown[]): void
    error(message: unknown, ...args: readonly unknown[]): void
    debug(message: unknown, ...args: readonly unknown[]): void
  }

  /** 释放一次注册。 */
  export type Disposer = () => void

  /** 插件 apply 收到的上下文（本插件用到的成员）。 */
  export interface Context {
    logger: Logger
    /** `inject: ['llm']` 声明之后才可用。 */
    llm: import('@deepseek-ai/dsh-llm').LlmRuntime
    /**
     * 可选服务读全局服务表。`ctx.<name>` 属性代理是拓扑敏感的，只给声明过的
     * 注入用；可选依赖一律走 `ctx.get`（见 harness packages/AGENTS.md）。
     */
    get(name: 'credentials'): import('@deepseek-ai/dsh-credentials').CredentialsService | undefined
    /** 注册即副作用：返回的 disposer 绑定在当前 fiber 上。 */
    effect(callback: () => Disposer | void, label?: string): Disposer
  }
}

declare module '@deepseek-ai/dsh-credentials' {
  /** packages/credentials —— 凭据引用解析。 */
  export interface CredentialsService {
    resolve(ref: string): Promise<{ value: string } | undefined>
  }
}

declare module '@deepseek-ai/dsh-llm' {
  import type { Disposer } from '@deepseek-ai/cordis'

  // ── packages/llm/llm/src/brand.ts ──

  /** 跨边界的不透明 id 一律带品牌，不用裸 string。 */
  export type Branded<B extends string> = string & { readonly __brand: B }
  export type CallId = Branded<'CallId'>
  export type MessageId = Branded<'MessageId'>
  export type SessionId = Branded<'SessionId'>

  // ── packages/llm/llm/src/types.ts ──

  export interface TextBlock { type: 'text', text: string }
  /** 推理 / 思考内容，与可见正文分开。 */
  export interface ReasoningBlock { type: 'reasoning', text: string }
  export interface ImageBlock { type: 'image', attachment: unknown }
  /** 模型请求的一次工具调用。 */
  export interface ToolCallBlock { type: 'tool-call', id: CallId, name: string, arguments: string }
  /** 回送给模型的工具执行结果。 */
  export interface ToolResultBlock {
    type: 'tool-result'
    toolCallId: CallId
    content: ContentBlock[]
    isError?: boolean
  }
  export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock
  export type ContentBlockType = ContentBlock['type']

  /** packages/llm/llm/src/message.ts */
  export interface Message {
    readonly id: MessageId
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: ContentBlock[]
    readonly source: { readonly kind: string, readonly [key: string]: unknown }
  }

  export interface ToolSchema {
    name: string
    description?: string
    inputSchema?: unknown
    [key: string]: unknown
  }

  export type ReasoningEffortId = 'off' | 'low' | 'high' | 'max' | (string & {})

  export interface GenerateOptions {
    provider: string
    model: string
    reasoningEffort?: ReasoningEffortId
    messages: Message[]
    system?: string
    tools?: ToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
    sessionId?: SessionId
    purpose?: 'compaction' | 'session-title'
  }

  /**
   * 计数是**不相交**的：`inputTokens` 只算未命中缓存的输入，命中的走
   * `cacheReadTokens`。把缓存折进 prompt 总数的 provider 要自己减出来。
   */
  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }

  export interface LlmFailure {
    code: string
    message: string
    [key: string]: unknown
  }

  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted', failure: LlmFailure }
    | { kind: 'error', failure: LlmFailure }

  export type StreamChunk =
    | { type: 'block-start', index: number, blockType: ContentBlockType }
    | { type: 'text-delta', index: number, text: string }
    | { type: 'reasoning-delta', index: number, text: string }
    | { type: 'tool-call-delta', index: number, id: CallId, name?: string, argumentsDelta: string }
    | { type: 'block-end', index: number, block: ContentBlock }
    | { type: 'usage', usage: TokenUsage }
    | { type: 'finish', reason: FinishReason }

  export interface LlmProviderInfo { id: string, name: string }

  export interface LlmModelInfo {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }

  export interface LlmModelContext {
    contextWindow: number
    maxOutputTokens?: number
  }

  export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext
  }

  /** 带错误码的 LLM 失败，consumer 据此分类处理。 */
  export class LlmError extends Error {
    constructor(message: string, code: string)
    readonly code: string
  }

  /**
   * 每个 provider 请求都必须带的归属头。header 名是小写（HTTP 字段名大小写不敏感）。
   * @returns 合并进请求的 header，当前只有 `user-agent`。
   */
  export function attributionHeaders(): Record<string, string>

  /** 注册进 `ctx.llm` 的适配器基类；只有 `stream` 是必须实现的。 */
  export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo
    listModels(provider: string): Promise<readonly LlmModelInfo[]>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }

  export interface AdapterRegistrationHandle {
    (): void
    replace(providers: string[]): void
  }

  export interface ConfigurableProvider {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
  }

  /** packages/llm —— 只列本插件调用到的方法。 */
  export interface LlmRuntime {
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
    /** 让 provider 出现在「模型」设置页里。 */
    registerConfigurableProviders(entries: readonly ConfigurableProvider[]): Disposer
  }
}
