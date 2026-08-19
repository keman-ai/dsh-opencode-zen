/**
 * SSE 增量 → harness 块序列的状态机。
 *
 * 单独成文件是为了可测：这里**只依赖类型**，不 import 任何 harness 运行时值，
 * 所以单测可以直接喂一条构造出来的流，不必先把整个 harness 装起来。
 *
 * 两边对「流」的建模不同：OpenAI 吐的是扁平增量（`delta.content` /
 * `delta.reasoning_content` / `delta.tool_calls[i]`），harness 要成对的块
 * （`block-start` → 若干 delta → `block-end` 带完整块）。一个块什么时候开始、
 * 什么时候结束，上游从不明说，全靠这里判断。
 */

import type { CallId, ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { sseLines } from './wire.ts'
import type { WireStreamEvent, WireUsage } from './wire.ts'

/** 一次流式响应的状态：哪些块开着、拼到哪儿了。 */
interface StreamState {
  nextIndex: number
  text: { index: number, parts: string[] } | undefined
  reasoning: { index: number, parts: string[] } | undefined
  /** 按上游 `tool_calls[].index` 聚合，值里的 `index` 是 harness 的块序号。 */
  tools: Map<number, { index: number, id: string, name: string, args: string[] }>
  finish: string | undefined
  usage: WireUsage | undefined
  sawToolCall: boolean
}

/**
 * 把一条 SSE 流消费成 harness 的块序列。
 *
 * @param body - 响应体。
 * @returns 块序列，末尾必有一个 `finish`。
 */
export async function* consume(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const state: StreamState = {
    nextIndex: 0,
    text: undefined,
    reasoning: undefined,
    tools: new Map(),
    finish: undefined,
    usage: undefined,
    sawToolCall: false,
  }

  for await (const payload of sseLines(body)) {
    let event: WireStreamEvent
    try {
      event = JSON.parse(payload) as WireStreamEvent
    } catch {
      // 单帧坏了不该让整轮对话失败：上游偶发的心跳文本、被截断的帧都归这里。
      continue
    }
    if (event.usage != null) {
      state.usage = event.usage
    }
    const choice = event.choices?.[0]
    if (choice === undefined) {
      continue
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      state.finish = choice.finish_reason
    }
    const delta = choice.delta
    if (delta === undefined) {
      continue
    }

    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      yield* openReasoning(state)
      state.reasoning?.parts.push(reasoning)
      yield { type: 'reasoning-delta', index: state.reasoning!.index, text: reasoning }
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      // 正文一开始就说明思考结束了，先把推理块收口，否则两个块会交错。
      yield* closeReasoning(state)
      yield* openText(state)
      state.text?.parts.push(delta.content)
      yield { type: 'text-delta', index: state.text!.index, text: delta.content }
    }

    for (const call of delta.tool_calls ?? []) {
      state.sawToolCall = true
      let entry = state.tools.get(call.index)
      if (entry === undefined) {
        // 工具调用一旦开始，正文和推理都不会再有内容，先收口保证块不交错。
        yield* closeReasoning(state)
        yield* closeText(state)
        entry = { index: state.nextIndex++, id: call.id ?? '', name: '', args: [] }
        state.tools.set(call.index, entry)
        yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
      }
      if (call.id !== undefined && call.id.length > 0) {
        entry.id = call.id
      }
      const name = call.function?.name
      if (name !== undefined && name.length > 0) {
        entry.name = name
      }
      const args = call.function?.arguments ?? ''
      if (args.length > 0) {
        entry.args.push(args)
      }
      if (args.length > 0 || name !== undefined) {
        yield {
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id as CallId,
          ...entry.name.length > 0 ? { name: entry.name } : {},
          argumentsDelta: args,
        }
      }
    }
  }

  yield* closeReasoning(state)
  yield* closeText(state)
  for (const entry of state.tools.values()) {
    const block: ContentBlock = {
      type: 'tool-call',
      id: entry.id as CallId,
      name: entry.name,
      arguments: entry.args.join(''),
    }
    yield { type: 'block-end', index: entry.index, block }
  }
  if (state.usage !== undefined) {
    yield { type: 'usage', usage: toTokenUsage(state.usage) }
  }
  yield { type: 'finish', reason: toFinishReason(state) }
}

function* openText(state: StreamState): Generator<StreamChunk> {
  if (state.text !== undefined) {
    return
  }
  state.text = { index: state.nextIndex++, parts: [] }
  yield { type: 'block-start', index: state.text.index, blockType: 'text' }
}

function* closeText(state: StreamState): Generator<StreamChunk> {
  const open = state.text
  if (open === undefined) {
    return
  }
  state.text = undefined
  yield { type: 'block-end', index: open.index, block: { type: 'text', text: open.parts.join('') } }
}

function* openReasoning(state: StreamState): Generator<StreamChunk> {
  if (state.reasoning !== undefined) {
    return
  }
  state.reasoning = { index: state.nextIndex++, parts: [] }
  yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
}

function* closeReasoning(state: StreamState): Generator<StreamChunk> {
  const open = state.reasoning
  if (open === undefined) {
    return
  }
  state.reasoning = undefined
  yield { type: 'block-end', index: open.index, block: { type: 'reasoning', text: open.parts.join('') } }
}

/**
 * 上游用量换算成 harness 的口径。
 *
 * 🔴 harness 要求三个计数**不相交**，而 OpenAI 风格的 `prompt_tokens` 把缓存命中
 * 折在里面。不减这一刀，带缓存的会话每轮都会把输入重复计一遍。
 */
function toTokenUsage(usage: WireUsage): TokenUsage {
  const prompt = usage.prompt_tokens ?? 0
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(prompt - cached, 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...cached > 0 ? { cacheReadTokens: cached } : {},
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

function toFinishReason(state: StreamState): FinishReason {
  switch (state.finish) {
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'stop':
      return { kind: 'stop' }
    default:
      // 有些网关在带工具调用的那一帧不给 finish_reason，或干脆不给。
      // 谁调了工具谁最清楚——以本轮是否产生过工具调用为准。
      return state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }
}
