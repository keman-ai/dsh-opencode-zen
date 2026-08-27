/**
 * The harness message vocabulary ↔ the OpenAI wire format.
 *
 * The shapes differ in one fundamental way: a harness message carries an **array of
 * content blocks** (text, reasoning, tool calls and tool results can share one message),
 * whereas an OpenAI message has a single role and a single content, and a tool result
 * must become its own `role: "tool"` message. So this is a one-to-many expansion, not
 * a field rename.
 */

import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireToolCall, WireToolSchema } from './wire.ts'

/**
 * Convert harness history into OpenAI messages.
 *
 * @param messages - Conversation history; the order is what the model sees.
 * @param system - System prompt; when present it becomes the first `role: "system"`.
 * @returns The wire-format message array.
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
        // Reasoning is **not** sent back: vendors handle "replay last turn's thinking"
        // incompatibly, and OpenAI-compatible chat/completions has no field for it.
        break
      case 'image':
        // None of the seven catalogued models declare image input, so this plugin is text-only.
        break
      case 'tool-call':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        break
      case 'tool-result':
        // A tool result must be its own message, ordered after the assistant message that
        // issued the call — flush pending text/calls first to keep the order right.
        flush(out, message.role, text, toolCalls)
        out.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: flattenResult(block.content),
        })
        break
      default:
        // Content blocks are an extensible union: plugins may add new kinds. Skip unknown
        // ones rather than throw — a new block should not stop the whole request.
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
 * Flatten a tool result's content blocks into one string.
 *
 * OpenAI's `role: "tool"` message accepts only a string. Image blocks have no place
 * here, so a placeholder states that an image existed but this provider cannot accept
 * it — far more diagnosable than dropping it silently.
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
 * Convert tool schemas into the OpenAI `tools` array.
 *
 * @param tools - The harness tool schemas.
 * @returns The wire-format tools array, or undefined when empty — never send an empty
 *   array, as some gateways read it as "tool calls are forbidden this turn".
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
