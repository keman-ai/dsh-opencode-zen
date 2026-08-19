/**
 * SSE 增量 → 块序列。重点不是「字段能不能读出来」，而是**块的配对与顺序**：
 * 每个 block-start 都要有对应的 block-end，正文和推理不能交错，
 * 工具调用的分片要拼回完整参数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { consume } from '../src/stream.ts'

/** 把若干 SSE 文本片段做成流；片段边界故意不对齐行边界，模拟网络分片。 */
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

test('正文增量拼成一个 text 块，start/end 配对', async () => {
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

test('推理先于正文，且不与正文交错 —— 正文一开始就把推理块收口', async () => {
  const chunks = await collect(streamOf(
    frame({ reasoning_content: '想一下' }),
    frame({ reasoning_content: '……好了' }),
    frame({ content: '答案' }),
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
    block: { type: 'reasoning', text: '想一下……好了' },
  })
})

test('`reasoning` 与 `reasoning_content` 两种字段名都认', async () => {
  const chunks = await collect(streamOf(frame({ reasoning: 'via reasoning' }), frame({}, 'stop')))
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'via reasoning' })
})

test('工具调用的分片拼回完整参数，finish 判为 tool-calls', async () => {
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

test('并行的两个工具调用各占一个块', async () => {
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

test('工具调用会把已开的正文块先收口，不让两个块交错', async () => {
  const chunks = await collect(streamOf(
    frame({ content: '我来查一下' }),
    frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'grep', arguments: '{}' } }] }),
    frame({}, 'tool_calls'),
  ))
  const order = chunks.map(c => c.type)
  assert.ok(
    order.indexOf('block-end') < order.indexOf('block-start', 1),
    `正文块必须在工具块开始前结束，实际顺序：${order.join(' → ')}`,
  )
})

test('上游不给 finish_reason 时，按本轮有没有工具调用判定', async () => {
  const withTool = await collect(streamOf(
    frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'g', arguments: '{}' } }] }),
  ))
  assert.deepEqual(withTool.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const textOnly = await collect(streamOf(frame({ content: 'hi' })))
  assert.deepEqual(textOnly.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('length 映射成 max-tokens', async () => {
  const chunks = await collect(streamOf(frame({ content: 'a' }), frame({}, 'length')))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('🔴 用量把缓存命中从输入里减出来 —— 三个计数必须不相交', async () => {
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

test('OpenAI 风格的 prompt_tokens_details.cached_tokens 同样减', async () => {
  const usage = { prompt_tokens: 300, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } }
  const chunks = await collect(streamOf(`data: ${JSON.stringify({ choices: [], usage })}\n`))
  assert.deepEqual((chunks.find(c => c.type === 'usage') as { usage: unknown }).usage, {
    inputTokens: 200,
    outputTokens: 10,
    cacheReadTokens: 100,
  })
})

test('坏帧被跳过，不让整轮对话失败', async () => {
  const chunks = await collect(streamOf(
    'data: {不是 JSON\n',
    ': 这是注释行\n',
    'event: ping\n',
    frame({ content: 'ok' }),
    frame({}, 'stop'),
  ))
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'ok' })
})

test('一行 JSON 被网络劈成两半也能解析', async () => {
  const whole = frame({ content: '完整' })
  const cut = Math.floor(whole.length / 2)
  const chunks = await collect(streamOf(whole.slice(0, cut), whole.slice(cut), frame({}, 'stop')))
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: '完整' })
})

test('[DONE] 之后的内容一律不再产出', async () => {
  const chunks = await collect(streamOf(
    frame({ content: 'before' }),
    'data: [DONE]\n',
    frame({ content: 'after' }),
  ))
  assert.ok(!chunks.some(c => c.type === 'text-delta' && c.text === 'after'))
})

test('空流也以 finish 收尾 —— 消费方总能等到终止信号', async () => {
  assert.deepEqual(await collect(streamOf('')), [{ type: 'finish', reason: { kind: 'stop' } }])
})
