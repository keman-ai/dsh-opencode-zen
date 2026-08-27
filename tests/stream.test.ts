/**
 * SSE deltas → block sequence. The point is not "can the fields be read" but **block
 * pairing and ordering**: every block-start needs its block-end, text and reasoning must
 * never interleave, and tool-call shards must reassemble into complete arguments.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { consume } from '../src/stream.ts'

/** Build a stream from SSE text fragments; boundaries deliberately misalign with lines to mimic network chunking. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function frame(delta: unknown, finish?: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n`
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of consume(stream)) {
    out.push(chunk)
  }
  return out
}

test('text deltas assemble into one text block with paired start/end', async () => {
  const chunks = await collect(streamOf(
    frame({ content: 'Hello' }),
    frame({ content: ', world' }),
    frame({}, 'stop'),
    'data: [DONE]\n',
  ))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello' },
    { type: 'text-delta', index: 0, text: ', world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('reasoning precedes text and never interleaves — text starting closes the reasoning block', async () => {
  const chunks = await collect(streamOf(
    frame({ reasoning_content: 'let me think' }),
    frame({ reasoning_content: '… done' }),
    frame({ content: 'the answer' }),
    frame({}, 'stop'),
  ))
  assert.deepEqual(chunks.map(c => `${c.type}:${'index' in c ? c.index : ''}`), [
    'block-start:0',
    'reasoning-delta:0',
    'reasoning-delta:0',
    'block-end:0',
    'block-start:1',
    'text-delta:1',
    'block-end:1',
    'finish:',
  ])
  assert.deepEqual(chunks[3], {
    type: 'block-end',
    index: 0,
    block: { type: 'reasoning', text: 'let me think… done' },
  })
})

test('both `reasoning` and `reasoning_content` field names are accepted', async () => {
  const chunks = await collect(streamOf(frame({ reasoning: 'via reasoning' }), frame({}, 'stop')))
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'via reasoning' })
})

test('tool-call shards reassemble into complete arguments and finish reads tool-calls', async () => {
  const chunks = await collect(streamOf(
    frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
    frame({}, 'tool_calls'),
  ))
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('two parallel tool calls occupy one block each', async () => {
  const chunks = await collect(streamOf(
    frame({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'x', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'y', arguments: '{}' } },
    ] }),
    frame({}, 'tool_calls'),
  ))
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.equal(ends.length, 2)
  assert.deepEqual(ends.map(e => (e as { index: number }).index), [0, 1])
})

test('a tool call closes an open text block first, so the two never interleave', async () => {
  const chunks = await collect(streamOf(
    frame({ content: 'let me look that up' }),
    frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'grep', arguments: '{}' } }] }),
    frame({}, 'tool_calls'),
  ))
  const order = chunks.map(c => c.type)
  assert.ok(
    order.indexOf('block-end') < order.indexOf('block-start', 1),
    `the text block must end before the tool block starts; actual order: ${order.join(' → ')}`,
  )
})

test('with no finish_reason from upstream, decide from whether this turn produced tool calls', async () => {
  const withTool = await collect(streamOf(
    frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'g', arguments: '{}' } }] }),
  ))
  assert.deepEqual(withTool.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const textOnly = await collect(streamOf(frame({ content: 'hi' })))
  assert.deepEqual(textOnly.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('length maps to max-tokens', async () => {
  const chunks = await collect(streamOf(frame({ content: 'a' }), frame({}, 'length')))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('🔴 usage subtracts cache hits from input — the three counts must stay disjoint', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 }
  const chunks = await collect(streamOf(
    frame({ content: 'x' }),
    `data: ${JSON.stringify({ choices: [], usage })}\n`,
    frame({}, 'stop'),
  ))
  const reported = chunks.find(c => c.type === 'usage')
  assert.deepEqual(reported, {
    type: 'usage',
    usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 },
  })
})

test('OpenAI-style prompt_tokens_details.cached_tokens is subtracted too', async () => {
  const usage = { prompt_tokens: 300, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } }
  const chunks = await collect(streamOf(`data: ${JSON.stringify({ choices: [], usage })}\n`))
  assert.deepEqual((chunks.find(c => c.type === 'usage') as { usage: unknown }).usage, {
    inputTokens: 200,
    outputTokens: 10,
    cacheReadTokens: 100,
  })
})

test('bad frames are skipped rather than failing the turn', async () => {
  const chunks = await collect(streamOf(
    'data: {not JSON\n',
    ': this is a comment line\n',
    'event: ping\n',
    frame({ content: 'ok' }),
    frame({}, 'stop'),
  ))
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'ok' })
})

test('a JSON line split in half by the network still parses', async () => {
  const whole = frame({ content: 'complete' })
  const cut = Math.floor(whole.length / 2)
  const chunks = await collect(streamOf(whole.slice(0, cut), whole.slice(cut), frame({}, 'stop')))
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'complete' })
})

test('nothing is emitted after [DONE]', async () => {
  const chunks = await collect(streamOf(
    frame({ content: 'before' }),
    'data: [DONE]\n',
    frame({ content: 'after' }),
  ))
  assert.ok(!chunks.some(c => c.type === 'text-delta' && c.text === 'after'))
})

test('even an empty stream ends with finish — consumers always get a terminator', async () => {
  assert.deepEqual(await collect(streamOf('')), [{ type: 'finish', reason: { kind: 'stop' } }])
})
