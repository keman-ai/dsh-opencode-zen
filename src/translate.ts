/**
 * harness 的消息词汇 ↔ OpenAI 线格式。
 *
 * 两边的形状差在一处根本的地方：harness 的一条消息带一个**内容块数组**（正文、
 * 推理、工具调用、工具结果可以混在同一条里），而 OpenAI 的一条消息只有一种角色
 * 和一份内容，工具结果还必须单独成条 `role: "tool"`。所以这里是一对多的展开，
 * 不是字段改名。
 */

import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireToolCall, WireToolSchema } from './wire.ts'

/**
 * 把 harness 历史转成 OpenAI messages。
 *
 * @param messages - 会话历史，顺序即模型看到的顺序。
 * @param system - 系统提示；有值时作为第一条 `role: "system"`。
 * @returns 线格式消息数组。
 */
export function toWireMessages(messages: readonly Message[], system?: string): WireMessage[] {
  const out: WireMessage[] = []
  if (system !== undefined && system.length > 0) {
    out.push({ role: 'system', content: system })
  }
  for (const message of messages) {
    pushMessage(out, message)
  }
  return out
}

function pushMessage(out: WireMessage[], message: Message): void {
  const text: string[] = []
  const toolCalls: WireToolCall[] = []

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'reasoning':
        // 推理内容**不回传**：各家对「把上一轮的思考再喂回去」的处理互不兼容，
        // 而 OpenAI 兼容的 chat/completions 根本没有承载它的请求字段。
        break
      case 'image':
        // 目录里七个模型都没声明图片输入，本插件按纯文本 provider 处理。
        break
      case 'tool-call':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        break
      case 'tool-result':
        // 工具结果必须单独成条，且要排在发起调用的那条 assistant 之后 ——
        // 先把已攒的正文/调用冲出去，顺序才不会乱。
        flush(out, message.role, text, toolCalls)
        out.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: flattenResult(block.content),
        })
        break
      default:
        // 内容块是可合并扩展的联合：插件可能加新块。不认识就跳过，
        // 不要抛 —— 一条消息里出现新块不该让整轮请求发不出去。
        break
    }
  }
  flush(out, message.role, text, toolCalls)
}

function flush(
  out: WireMessage[],
  role: Message['role'],
  text: string[],
  toolCalls: WireToolCall[],
): void {
  if (text.length === 0 && toolCalls.length === 0) {
    return
  }
  const content = text.join('')
  const wire: WireMessage = { role: role === 'system' ? 'system' : role }
  if (content.length > 0) {
    wire.content = content
  }
  if (toolCalls.length > 0) {
    wire.tool_calls = [...toolCalls]
  }
  out.push(wire)
  text.length = 0
  toolCalls.length = 0
}

/**
 * 工具结果的内容块压成一段文本。
 *
 * OpenAI 的 `role: "tool"` 消息只收字符串。结果里的图片块在这里没有位置，
 * 用占位符点明「有一张图但这个 provider 收不了」，比静默丢弃可诊断。
 */
function flattenResult(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push('[image omitted: this provider accepts text only]')
        break
      case 'reasoning':
        parts.push(block.text)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * 工具 schema 转成 OpenAI `tools` 数组。
 *
 * @param tools - harness 的工具 schema。
 * @returns 线格式工具数组；入参为空时 undefined（不要发空数组，部分网关会因此
 *   认为「本轮禁止调用工具」）。
 */
export function toWireTools(tools: readonly ToolSchema[] | undefined): WireToolSchema[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined
  }
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      ...tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema },
    },
  }))
}
