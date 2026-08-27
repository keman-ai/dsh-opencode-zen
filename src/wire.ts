/**
 * OpenCode Zen's wire format: the OpenAI `/chat/completions` shape, plus SSE line parsing.
 *
 * models.dev lists Zen's SDK as `@ai-sdk/openai-compatible`, so we treat it as
 * OpenAI-compatible. Only the fields this plugin actually reads or writes are declared;
 * the rest pass through ignored — the gateway may add fields at any time, and modelling
 * them would only make the types compete with reality over which one is true.
 */

/** An OpenAI-style request message. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  /** Tool calls issued by the assistant. */
  tool_calls?: WireToolCall[]
  /** For role `tool`, the id of the call being answered. */
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
  /** Ask the gateway for usage on the final frame. Not all upstreams send it; absent means absent. */
  stream_options?: { include_usage: boolean }
  tools?: WireToolSchema[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** The incremental `choices[0].delta` of a streamed response. */
export interface WireDelta {
  role?: string
  content?: string | null
  /**
   * Vendors disagree on the reasoning field name: DeepSeek-family uses
   * `reasoning_content`, other OpenAI-compatible gateways use `reasoning`.
   * Read both; whichever carries a value wins.
   */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** Tool calls arrive sharded by `index`; `id`/`name` usually appear only in the first shard. */
export interface WireToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string, arguments?: string }
}

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** DeepSeek-style cache hits, folded into prompt_tokens — subtract when computing usage. */
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

/** The gateway's error envelope, e.g. `{"type":"error","error":{"type":"FreeUsageLimitError",...}}`. */
export interface WireError {
  error?: { type?: string, message?: string, code?: string }
  message?: string
}

/**
 * Split a byte stream into SSE `data:` payloads.
 *
 * Only `data:` lines count; comments, `event:` and keep-alive blanks are skipped.
 * `[DONE]` is a terminator, not a payload. A partial line is held in the buffer —
 * network chunking splits a JSON line in two, and parsing per chunk is the most
 * common bug in implementations like this.
 *
 * @param stream - The response body byte stream.
 * @returns The raw payload text of each `data:` line.
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
    // When upstream omits the trailing newline, the last line exists only in the buffer.
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice('data:'.length).trim()
      if (payload.length > 0 && payload !== '[DONE]') {
        yield payload
      }
    }
  } finally {
    // Early return ([DONE], downstream break, abort) without releasing would hang the connection.
    reader.releaseLock()
  }
}
