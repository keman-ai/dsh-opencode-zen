/**
 * 目录发现：免费判定、双源交叉、以及「上游不可用时不能把插件拖垮」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Catalog, freeModels } from '../src/discovery.ts'
import { FALLBACK_MODELS } from '../src/catalog.ts'

const devApi = {
  opencode: {
    models: {
      'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 } },
      'nemotron-3-ultra-free': { id: 'nemotron-3-ultra-free', name: 'Ultra', cost: { input: 0, output: 0 }, limit: { context: 1_000_000, output: 128_000 } },
      'claude-opus-5': { id: 'claude-opus-5', name: 'Opus', cost: { input: 5, output: 25 }, limit: { context: 200_000, output: 64_000 } },
      'retired-free': { id: 'retired-free', name: 'Retired', cost: { input: 0, output: 0 }, limit: { context: 100_000, output: 8000 } },
    },
  },
}

test('免费判定看价格而不是 id 后缀 —— big-pickle 没有 -free 也是免费', () => {
  const ids = freeModels(devApi).map(m => m.id)
  assert.ok(ids.includes('big-pickle'))
  assert.ok(!ids.includes('claude-opus-5'), '付费模型不该进目录')
})

test('按上下文容量降序 —— 免费模型最常撞的墙是上下文不够', () => {
  assert.deepEqual(freeModels(devApi).map(m => m.contextWindow), [1_000_000, 200_000, 100_000])
})

test('🔴 zen 已下架的条目被剔除 —— 限时免费的模型迟早走这条路', () => {
  const live = new Set(['big-pickle', 'nemotron-3-ultra-free', 'claude-opus-5'])
  const ids = freeModels(devApi, live).map(m => m.id)
  assert.deepEqual(ids, ['nemotron-3-ultra-free', 'big-pickle'])
  assert.ok(!ids.includes('retired-free'))
})

test('zen 那一路拿不到时不做过滤 —— 「无法确认」不等于「全都没了」', () => {
  assert.equal(freeModels(devApi, undefined).length, 3)
})

test('缺容量的条目跳过：没有 contextWindow 的目录项对压缩策略没用', () => {
  const broken = { opencode: { models: { x: { id: 'x', cost: { input: 0, output: 0 } } } } }
  assert.deepEqual(freeModels(broken), [])
})

test('响应结构不认识时返回空，让调用方回落快照而不是抛', () => {
  assert.deepEqual(freeModels({}), [])
  assert.deepEqual(freeModels({ opencode: {} }), [])
})

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
}

test('两个源都通时给出实时目录', async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/models'
      ? { data: [{ id: 'big-pickle' }, { id: 'nemotron-3-ultra-free' }] }
      : devApi))
  })
  try {
    const catalog = new Catalog({
      catalogUrl: `${server.origin}/api.json`,
      modelsUrl: `${server.origin}/models`,
      ttlMs: 60_000,
      timeoutMs: 5000,
    })
    const result = await catalog.list()
    assert.equal(result.source, 'live')
    assert.deepEqual(result.models.map(m => m.id), ['nemotron-3-ultra-free', 'big-pickle'])
  } finally {
    await server.close()
  }
})

test('第二次在 TTL 内走缓存，不再打上游', async () => {
  let hits = 0
  const server = await serve((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/models' ? { data: [{ id: 'big-pickle' }] } : devApi))
  })
  try {
    const catalog = new Catalog({
      catalogUrl: `${server.origin}/api.json`,
      modelsUrl: `${server.origin}/models`,
      ttlMs: 60_000,
      timeoutMs: 5000,
    })
    await catalog.list()
    const first = hits
    const second = await catalog.list()
    assert.equal(second.source, 'cache')
    assert.equal(hits, first, '缓存期内不该再打上游')
  } finally {
    await server.close()
  }
})

test('🔴 上游挂了回落到随包快照，而不是抛错或给空列表', async () => {
  const server = await serve((_req, res) => { res.writeHead(500); res.end('boom') })
  try {
    const catalog = new Catalog({
      catalogUrl: `${server.origin}/api.json`,
      modelsUrl: `${server.origin}/models`,
      ttlMs: 60_000,
      timeoutMs: 2000,
    })
    const result = await catalog.list()
    assert.equal(result.source, 'fallback')
    assert.deepEqual(result.models, FALLBACK_MODELS)
  } finally {
    await server.close()
  }
})

test('连不上也一样回落，不抛', async () => {
  const catalog = new Catalog({
    catalogUrl: 'http://127.0.0.1:1/api.json',
    modelsUrl: 'http://127.0.0.1:1/models',
    ttlMs: 60_000,
    timeoutMs: 1000,
  })
  const result = await catalog.list()
  assert.equal(result.source, 'fallback')
  assert.ok(result.models.length > 0)
})

test('peek 不发请求：缓存没热时直接给快照', async () => {
  const catalog = new Catalog({
    catalogUrl: 'http://127.0.0.1:1/api.json',
    modelsUrl: 'http://127.0.0.1:1/models',
    ttlMs: 60_000,
    timeoutMs: 1000,
  })
  assert.deepEqual(catalog.peek(), FALLBACK_MODELS)
})

test('并发调用只打一次上游', async () => {
  let hits = 0
  const server = await serve((req, res) => {
    hits += 1
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/models' ? { data: [{ id: 'big-pickle' }] } : devApi))
    }, 20)
  })
  try {
    const catalog = new Catalog({
      catalogUrl: `${server.origin}/api.json`,
      modelsUrl: `${server.origin}/models`,
      ttlMs: 60_000,
      timeoutMs: 5000,
    })
    await Promise.all([catalog.list(), catalog.list(), catalog.list()])
    // 一轮 = 两个源各一次；去重生效的话不会变成六次。
    assert.equal(hits, 2, `期望两次请求，实际 ${hits}`)
  } finally {
    await server.close()
  }
})
