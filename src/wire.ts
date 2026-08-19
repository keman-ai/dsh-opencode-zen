/**
 * OpenCode Zen 的线格式：OpenAI `/chat/completions` 那一套，加上 SSE 行解析。
 *
 * Zen 在 models.dev 上登记的 SDK 就是 `@ai-sdk/openai-compatible`，所以这里按
 * OpenAI 兼容处理。只声明本插件真正读写的字段，多余的原样忽略 —— 网关随时可能
 * 多送字段，为它们建模只会让类型和实际收到的东西争夺「哪个才是真的」。
 */

/** 一条 OpenAI 风格的请求消息。 */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  /** assistant 发起的工具调用。 */
  tool_calls?: WireToolCall[]
  /** role 为 tool 时，对应的调用 id。 */
  tool_call_id?: string
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

export interface WireToolSchema {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  /** 让网关在最后一帧带上用量；不是所有上游都给，缺了就当没有。 */
  stream_options?: { include_usage: boolean }
  tools?: WireToolSchema[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** 流式响应里 `choices[0].delta` 的增量部分。 */
export interface WireDelta {
  role?: string
  content?: string | null
  /**
   * 推理内容的字段名各家不统一：DeepSeek 系用 `reasoning_content`，另一些
   * OpenAI 兼容网关用 `reasoning`。两个都读，谁有值用谁。
   */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** 工具调用在流里是按 `index` 分片拼起来的，`id`/`name` 通常只在第一片出现。 */
export interface WireToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string, arguments?: string }
}

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** DeepSeek 风格的缓存命中数，折在 prompt_tokens 里，用量换算时要减出来。 */
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireStreamEvent {
  choices?: {
    index?: number
    delta?: WireDelta
    finish_reason?: string | null
  }[]
  usage?: WireUsage | null
}

/** 网关的错误信封，如 `{"type":"error","error":{"type":"FreeUsageLimitError",...}}`。 */
export interface WireError {
  error?: { type?: string, message?: string, code?: string }
  message?: string
}

/**
 * 把字节流切成 SSE `data:` 负载。
 *
 * 只认 `data:` 行，其余（注释、`event:`、心跳空行）跳过；`[DONE]` 是终止哨兵，
 * 不作为负载吐出。跨 chunk 的半行留在缓冲里 —— 网络分片会把一行 JSON 劈成两半，
 * 逐 chunk 解析是这类实现最常见的错。
 *
 * @param stream - 响应体的字节流。
 * @returns 每个 `data:` 行的原始负载文本。
 */
export async function* sseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) {
          continue
        }
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') {
          return
        }
        if (payload.length > 0) {
          yield payload
        }
      }
    }
    // 上游不发结尾换行时，最后一行只存在于缓冲里。
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice('data:'.length).trim()
      if (payload.length > 0 && payload !== '[DONE]') {
        yield payload
      }
    }
  } finally {
    // 提前 return（[DONE]、下游 break、abort）时不释放会把连接吊住。
    reader.releaseLock()
  }
}
