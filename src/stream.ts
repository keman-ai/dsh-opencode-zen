/**
 * State machine turning SSE deltas into the harness block sequence.
 *
 * It lives in its own file to stay testable: it depends on **types only** and imports
 * no harness runtime value, so a unit test can feed it a synthetic stream without
 * standing up the whole harness.
 *
 * The two sides model "a stream" differently: OpenAI emits flat deltas
 * (`delta.content` / `delta.reasoning_content` / `delta.tool_calls[i]`), the harness
 * wants paired blocks (`block-start` → deltas → `block-end` with the full block).
 * Upstream never states when a block begins or ends; this file decides.
 */

import type { CallId, ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { sseLines } from './wire.ts'
import type { WireStreamEvent, WireUsage } from './wire.ts'

/** State of one streamed response: which blocks are open and how far they are assembled. */
interface StreamState {
  nextIndex: number
  text: { index: number, parts: string[] } | undefined
  reasoning: { index: number, parts: string[] } | undefined
  /** Keyed by upstream `tool_calls[].index`; the `index` in the value is the harness block ordinal. */
  tools: Map<number, { index: number, id: string, name: string, args: string[] }>
  finish: string | undefined
  usage: WireUsage | undefined
  sawToolCall: boolean
}

/**
 * Consume an SSE stream into the harness block sequence.
 *
 * @param body - The response body.
 * @returns The block sequence, always ending with a `finish`.
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
      // One bad frame must not fail the turn: stray keep-alive text and truncated frames land here.
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
      // Text starting means thinking ended — close the reasoning block first, or the two interleave.
      yield* closeReasoning(state)
      yield* openText(state)
      state.text?.parts.push(delta.content)
      yield { type: 'text-delta', index: state.text!.index, text: delta.content }
    }

    for (const call of delta.tool_calls ?? []) {
      state.sawToolCall = true
      let entry = state.tools.get(call.index)
      if (entry === undefined) {
        // Once tool calls begin, text and reasoning are done — close them so blocks never interleave.
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
 * Convert upstream usage into the harness's accounting.
 *
 * 🔴 The harness requires the three counts to be **disjoint**, but OpenAI-style
 * `prompt_tokens` folds cache hits into itself. Without subtracting them, a cached
 * conversation double-counts its input every turn.
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
      // Some gateways omit finish_reason on the tool-call frame, or omit it entirely.
      // We know best whether tools were called — decide from what this turn produced.
      return state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }
}
