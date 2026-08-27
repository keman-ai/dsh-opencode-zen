/**
 * Declarations for the parts of the DeepSeek Harness API we use, transcribed from the `0.1.0-rc.7` source, each with its origin noted.
 *
 * Why vendored instead of depending on the npm package: `@deepseek-ai/dsh-llm` on npm is
 * stuck at `0.0.1-rc.1` and its types no longer match the current harness (`0.1.0-rc.7`),
 * so installing it breaks the build. These modules are all external at runtime — the
 * implementation comes from the harness process hosting this plugin, and both `LlmAdapter`
 * and `attributionHeaders` must resolve to the host's implementation at runtime.
 *
 * When host behaviour disagrees with these declarations, check the harness source first — do not bend the code to fit the declarations.
 */

declare module '@deepseek-ai/cordis' {
  /** The cordis Logger facade is `Record<'error'|'info'|'warn'|'debug', LoggerMethod>`; only what we use is listed. */
  export interface Logger {
    info(message: unknown, ...args: readonly unknown[]): void
    warn(message: unknown, ...args: readonly unknown[]): void
    error(message: unknown, ...args: readonly unknown[]): void
    debug(message: unknown, ...args: readonly unknown[]): void
  }

  /** Release one registration. */
  export type Disposer = () => void

  /** The context a plugin's apply receives (only the members this plugin uses). */
  export interface Context {
    logger: Logger
    /** Available only after declaring `inject: ['llm']`. */
    llm: import('@deepseek-ai/dsh-llm').LlmRuntime
    /**
     * Optional services read the global service table. The `ctx.<name>` property proxy is
     * topology-sensitive and is only for declared injections; optional dependencies always
     * go through `ctx.get` (see the harness packages/AGENTS.md).
     */
    get(name: 'credentials'): import('@deepseek-ai/dsh-credentials').CredentialsService | undefined
    /** Registration is an effect: the returned disposer is bound to the current fiber. */
    effect(callback: () => Disposer | void, label?: string): Disposer
  }
}

declare module '@deepseek-ai/dsh-credentials' {
  /** packages/credentials — credential reference resolution. */
  export interface CredentialsService {
    resolve(ref: string): Promise<{ value: string } | undefined>
  }
}

declare module '@deepseek-ai/dsh-llm' {
  import type { Disposer } from '@deepseek-ai/cordis'

  // ── packages/llm/llm/src/brand.ts ──

  /** Opaque ids crossing boundaries are branded, never bare strings. */
  export type Branded<B extends string> = string & { readonly __brand: B }
  export type CallId = Branded<'CallId'>
  export type MessageId = Branded<'MessageId'>
  export type SessionId = Branded<'SessionId'>

  // ── packages/llm/llm/src/types.ts ──

  export interface TextBlock { type: 'text', text: string }
  /** Reasoning / thinking content, kept separate from visible text. */
  export interface ReasoningBlock { type: 'reasoning', text: string }
  export interface ImageBlock { type: 'image', attachment: unknown }
  /** A tool call requested by the model. */
  export interface ToolCallBlock { type: 'tool-call', id: CallId, name: string, arguments: string }
  /** A tool execution result sent back to the model. */
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
   * The counts are **disjoint**: `inputTokens` covers only cache-missed input, while hits
   * go to `cacheReadTokens`. A provider that folds cache into the prompt total must
   * subtract it itself.
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

  /** An LLM failure carrying a code, so consumers can classify it. */
  export class LlmError extends Error {
    constructor(message: string, code: string)
    readonly code: string
  }

  /**
   * Attribution headers every provider request must carry. Names are lowercase (HTTP field
   * names are case-insensitive).
   * @returns Headers merged into the request; currently only `user-agent`.
   */
  export function attributionHeaders(): Record<string, string>

  /** Base class for adapters registered with `ctx.llm`; only `stream` must be implemented. */
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

  /** packages/llm — only the methods this plugin calls. */
  export interface LlmRuntime {
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
    /** Makes the provider appear on the Models settings page. */
    registerConfigurableProviders(entries: readonly ConfigurableProvider[]): Disposer
  }
}
