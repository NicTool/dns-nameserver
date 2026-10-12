// Event mode is only usable if something actually emits 'zoneChanged'. Nothing
// did, so a nameserver with interval 0 published once at startup and served that
// snapshot forever.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'

import FileSource from '../lib/source/file.js'
import MysqlSource from '../lib/source/mysql.js'
import Source from '../lib/source/base.js'

let dir
let sources

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-watch-'))
  sources = []
})

// A failed assertion skips the test's own disconnect(), and an open watcher
// keeps the runner alive until the CI job times out.
afterEach(async () => {
  await Promise.all(sources.map((s) => s.disconnect()))
  await fs.rm(dir, { recursive: true, force: true })
})

async function open(opts) {
  const src = new FileSource({ path: dir, ...opts })
  sources.push(src)
  await src.connect()
  return src
}

const write = (base, obj) =>
  fs.writeFile(path.join(dir, `${base}.json`), JSON.stringify(obj, null, 1))

function nextEvent(emitter, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${name} within ${timeoutMs}ms`)),
      timeoutMs,
    )
    emitter.once(name, (detail) => {
      clearTimeout(timer)
      resolve(detail)
    })
  })
}

describe('Source.notifyZoneChanged', () => {
  it('lets any source drive event mode from outside', async () => {
    const src = new Source()
    const seen = nextEvent(src, 'zoneChanged')
    src.notifyZoneChanged({ reason: 'test' })
    assert.deepEqual(await seen, { reason: 'test' })
  })

  it('reports that the base source does not self-detect', () => {
    assert.equal(new Source().watches, false)
  })
})

describe('FileSource watching', () => {
  it('emits zoneChanged when the zone file is rewritten', async () => {
    await write('zone', { zone: [{ id: 1, zone: 'example.com', ttl: 3600 }] })

    const src = await open({ settleMs: 20 })
    assert.equal(src.watches, true, 'should be watching after connect')

    const seen = nextEvent(src, 'zoneChanged')
    await write('zone', { zone: [{ id: 1, zone: 'example.com', ttl: 7200 }] })
    await seen

    await src.disconnect()
    assert.equal(src.watches, false, 'should stop watching after disconnect')
  })

  it('emits when a record file appears that did not exist yet', async () => {
    const src = await open({ settleMs: 20 })

    const seen = nextEvent(src, 'zoneChanged')
    await write('zone_record', { zone_record: [{ id: 1, zid: 1, type: 'A' }] })
    await seen
  })

  it('survives a write-then-rename, which replaces the inode', async () => {
    await write('zone', { zone: [] })
    const src = await open({ settleMs: 20 })

    const seen = nextEvent(src, 'zoneChanged')
    const tmp = path.join(dir, 'zone.json.tmp')
    await fs.writeFile(tmp, JSON.stringify({ zone: [{ id: 2, zone: 'b.com' }] }))
    await fs.rename(tmp, path.join(dir, 'zone.json'))
    await seen
  })

  it('collapses one edit into one event', async () => {
    await write('zone', { zone: [] })
    // settleMs must exceed the gap between writes, which reached ~110ms on a
    // loaded CI runner.
    const src = await open({ settleMs: 300 })

    let count = 0
    src.on('zoneChanged', () => count++)

    for (let i = 0; i < 5; i++) {
      await write('zone', { zone: [{ id: i, zone: `z${i}.com` }] })
    }
    await new Promise((r) => setTimeout(r, 900))

    assert.equal(count, 1, `expected a single coalesced event, got ${count}`)
  })

  it('ignores files it does not read', async () => {
    await write('zone', { zone: [] })
    const src = await open({ settleMs: 20 })
    // Let any event for the write above drain before counting.
    await new Promise((r) => setTimeout(r, 250))

    let count = 0
    src.on('zoneChanged', () => count++)
    await write('nameserver', { nameserver: [{ id: 1 }] })
    await new Promise((r) => setTimeout(r, 250))

    assert.equal(count, 0)
  })

  it('reports watches=false when the directory is absent', async () => {
    const src = await open({ path: path.join(dir, 'nope'), settleMs: 20 })
    assert.equal(src.watches, false)
  })
})

describe('MysqlSource watching', () => {
  // The 2.x schema has no maintained change feed, so this source can only be
  // told. Asserted so the form keeps requiring interval > 0 for MySQL.
  it('does not self-detect, but accepts an external notification', async () => {
    const src = new MysqlSource({ host: '127.0.0.1', database: 'unused' })
    assert.equal(src.watches, false)

    const seen = nextEvent(src, 'zoneChanged')
    src.notifyZoneChanged({ reason: 'api write' })
    assert.deepEqual(await seen, { reason: 'api write' })
  })
})
