/**
 * harness 消息 → OpenAI 线格式。
 *
 * 核心差异是一对多：harness 一条消息带一个内容块数组，而工具结果在 OpenAI 那边
 * 必须单独成条 `role: "tool"`，且要排在发起调用的 assistant 之后。顺序错了模型
 * 会看到一个没有来由的结果。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CallId, ContentBlock, Message, MessageId } from '@deepseek-ai/dsh-llm'
import { toWireMessages, toWireTools } from '../src/translate.ts'

function message(role: Message['role'], content: ContentBlock[]): Message {
  return { id: 'm1' as MessageId, role, content, source: { kind: 'user' } }
}

test('system 提示排在最前', () => {
  const wire = toWireMessages([message('user', [{ type: 'text', text: 'hi' }])], '你是助手')
  assert.deepEqual(wire, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hi' },
  ])
})

test('空 system 不产生空消息', () => {
  assert.equal(toWireMessages([message('user', [{ type: 'text', text: 'hi' }])], '').length, 1)
  assert.equal(toWireMessages([message('user', [{ type: 'text', text: 'hi' }])]).length, 1)
})

test('同一条里的正文与工具调用合成一条 assistant', () => {
  const wire = toWireMessages([message('assistant', [
    { type: 'text', text: '我查一下' },
    { type: 'tool-call', id: 'c1' as CallId, name: 'read', arguments: '{"path":"a"}' },
  ])])
  assert.deepEqual(wire, [{
    role: 'assistant',
    content: '我查一下',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
  }])
})

test('🔴 工具结果单独成条，且排在发起调用的那条之后', () => {
  const wire = toWireMessages([
    message('assistant', [{ type: 'tool-call', id: 'c1' as CallId, name: 'read', arguments: '{}' }]),
    message('user', [{ type: 'tool-result', toolCallId: 'c1' as CallId, content: [{ type: 'text', text: '文件内容' }] }]),
  ])
  assert.deepEqual(wire, [
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
  ])
})

test('一条消息里同时有正文和工具结果时，正文先冲出去', () => {
  const wire = toWireMessages([message('user', [
    { type: 'text', text: '先说一句' },
    { type: 'tool-result', toolCallId: 'c1' as CallId, content: [{ type: 'text', text: '结果' }] },
  ])])
  assert.deepEqual(wire.map(m => m.role), ['user', 'tool'])
})

test('推理块不回传 —— chat/completions 没有承载它的请求字段', () => {
  const wire = toWireMessages([message('assistant', [
    { type: 'reasoning', text: '内心戏' },
    { type: 'text', text: '结论' },
  ])])
  assert.deepEqual(wire, [{ role: 'assistant', content: '结论' }])
})

test('只有推理块的消息整条消失，而不是发一条空消息', () => {
  assert.deepEqual(toWireMessages([message('assistant', [{ type: 'reasoning', text: '只想不说' }])]), [])
})

test('工具结果里的图片给出占位说明，而不是静默丢掉', () => {
  const wire = toWireMessages([message('user', [
    { type: 'tool-result', toolCallId: 'c1' as CallId, content: [
      { type: 'text', text: '截图如下' },
      { type: 'image', attachment: {} },
    ] },
  ])])
  assert.match(String(wire[0]?.content), /截图如下[\s\S]*image omitted/)
})

test('未知内容块被跳过，不让整轮请求发不出去', () => {
  const exotic = { type: 'video', src: 'x' } as unknown as ContentBlock
  const wire = toWireMessages([message('user', [exotic, { type: 'text', text: '还在' }])])
  assert.deepEqual(wire, [{ role: 'user', content: '还在' }])
})

test('工具 schema 转成 OpenAI tools；没有工具时返回 undefined 而不是空数组', () => {
  assert.equal(toWireTools(undefined), undefined)
  assert.equal(toWireTools([]), undefined)
  assert.deepEqual(toWireTools([{ name: 'read', description: '读文件', inputSchema: { type: 'object' } }]), [{
    type: 'function',
    function: { name: 'read', description: '读文件', parameters: { type: 'object' } },
  }])
})
