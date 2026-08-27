/**
 * Catalog discovery: the free verdict, the two-source intersection, and "an unreachable upstream must not drag the plugin down".
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

test('the free verdict reads price, not the id suffix — big-pickle is free without -free', () => {
  const ids = freeModels(devApi).map(m => m.id)
  assert.ok(ids.includes('big-pickle'))
  assert.ok(!ids.includes('claude-opus-5'), 'paid models must not enter the catalog')
})

test('sorted by context size, largest first — the wall free models hit most often', () => {
  assert.deepEqual(freeModels(devApi).map(m => m.contextWindow), [1_000_000, 200_000, 100_000])
})

test('🔴 entries withdrawn by zen are dropped — the eventual fate of every time-limited free model', () => {
  const live = new Set(['big-pickle', 'nemotron-3-ultra-free', 'claude-opus-5'])
  const ids = freeModels(devApi, live).map(m => m.id)
  assert.deepEqual(ids, ['nemotron-3-ultra-free', 'big-pickle'])
  assert.ok(!ids.includes('retired-free'))
})

test('no filtering when the zen source fails — "unconfirmed" is not "all gone"', () => {
  assert.equal(freeModels(devApi, undefined).length, 3)
})

test('entries without a context window are skipped: they are useless to the compaction strategy', () => {
  const broken = { opencode: { models: { x: { id: 'x', cost: { input: 0, output: 0 } } } } }
  assert.deepEqual(freeModels(broken), [])
})

test('an unrecognised response shape returns empty, so the caller falls back to the snapshot instead of throwing', () => {
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

test('with both sources reachable, the catalog is live', async () => {
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

test('a second call within the TTL is served from cache, not upstream', async () => {
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
    assert.equal(hits, first, 'no upstream calls while the cache is warm')
  } finally {
    await server.close()
  }
})

test('🔴 a dead upstream falls back to the bundled snapshot, not an error or an empty list', async () => {
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

test('a connection failure falls back the same way, without throwing', async () => {
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

test('peek makes no request: a cold cache returns the snapshot directly', async () => {
  const catalog = new Catalog({
    catalogUrl: 'http://127.0.0.1:1/api.json',
    modelsUrl: 'http://127.0.0.1:1/models',
    ttlMs: 60_000,
    timeoutMs: 1000,
  })
  assert.deepEqual(catalog.peek(), FALLBACK_MODELS)
})

test('concurrent calls hit upstream once', async () => {
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
    // One round = one call per source; with dedup working this never becomes six.
    assert.equal(hits, 2, `expected two requests, got ${hits}`)
  } finally {
    await server.close()
  }
})
