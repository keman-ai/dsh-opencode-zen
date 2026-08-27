/**
 * Harness messages → the OpenAI wire format.
 *
 * The core difference is one-to-many: a harness message carries an array of content
 * blocks, while on the OpenAI side a tool result must be its own `role: "tool"` message
 * ordered after the assistant that issued the call. Get the order wrong and the model
 * sees a result with no cause.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CallId, ContentBlock, Message, MessageId } from '@deepseek-ai/dsh-llm'
import { toWireMessages, toWireTools } from '../src/translate.ts'

function message(role: Message['role'], content: ContentBlock[]): Message {
  return { id: 'm1' as MessageId, role, content, source: { kind: 'user' } }
}

test('the system prompt comes first', () => {
  const wire = toWireMessages([message('user', [{ type: 'text', text: 'hi' }])], 'you are an assistant')
  assert.deepEqual(wire, [
    { role: 'system', content: 'you are an assistant' },
    { role: 'user', content: 'hi' },
  ])
})

test('an empty system prompt produces no message', () => {
  assert.equal(toWireMessages([message('user', [{ type: 'text', text: 'hi' }])], '').length, 1)
  assert.equal(toWireMessages([message('user', [{ type: 'text', text: 'hi' }])]).length, 1)
})

test('text and tool calls in one message merge into a single assistant message', () => {
  const wire = toWireMessages([message('assistant', [
    { type: 'text', text: 'let me check' },
    { type: 'tool-call', id: 'c1' as CallId, name: 'read', arguments: '{"path":"a"}' },
  ])])
  assert.deepEqual(wire, [{
    role: 'assistant',
    content: 'let me check',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
  }])
})

test('🔴 a tool result becomes its own message, ordered after the call that issued it', () => {
  const wire = toWireMessages([
    message('assistant', [{ type: 'tool-call', id: 'c1' as CallId, name: 'read', arguments: '{}' }]),
    message('user', [{ type: 'tool-result', toolCallId: 'c1' as CallId, content: [{ type: 'text', text: 'file contents' }] }]),
  ])
  assert.deepEqual(wire, [
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
  ])
})

test('when one message holds both text and a tool result, the text flushes first', () => {
  const wire = toWireMessages([message('user', [
    { type: 'text', text: 'one word first' },
    { type: 'tool-result', toolCallId: 'c1' as CallId, content: [{ type: 'text', text: 'result' }] },
  ])])
  assert.deepEqual(wire.map(m => m.role), ['user', 'tool'])
})

test('reasoning blocks are not sent back — chat/completions has no field for them', () => {
  const wire = toWireMessages([message('assistant', [
    { type: 'reasoning', text: 'inner monologue' },
    { type: 'text', text: 'conclusion' },
  ])])
  assert.deepEqual(wire, [{ role: 'assistant', content: 'conclusion' }])
})

test('a reasoning-only message disappears entirely rather than sending an empty one', () => {
  assert.deepEqual(toWireMessages([message('assistant', [{ type: 'reasoning', text: 'thought, not said' }])]), [])
})

test('an image in a tool result gets a placeholder instead of being dropped silently', () => {
  const wire = toWireMessages([message('user', [
    { type: 'tool-result', toolCallId: 'c1' as CallId, content: [
      { type: 'text', text: 'screenshot below' },
      { type: 'image', attachment: {} },
    ] },
  ])])
  assert.match(String(wire[0]?.content), /screenshot below[\s\S]*image omitted/)
})

test('unknown content blocks are skipped rather than blocking the whole request', () => {
  const exotic = { type: 'video', src: 'x' } as unknown as ContentBlock
  const wire = toWireMessages([message('user', [exotic, { type: 'text', text: 'still here' }])])
  assert.deepEqual(wire, [{ role: 'user', content: 'still here' }])
})

test('tool schemas convert to OpenAI tools; no tools returns undefined, not an empty array', () => {
  assert.equal(toWireTools(undefined), undefined)
  assert.equal(toWireTools([]), undefined)
  assert.deepEqual(toWireTools([{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }]), [{
    type: 'function',
    function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
  }])
})
