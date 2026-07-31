// Publish metrics exist so different export paths can be compared on the same
// ruler. The counts deliberately come from what the Source returned, not from
// each publisher's artifacts — those disagree, and two report nothing at all.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import Nameserver from '../lib/base.js'
import Publisher from '../lib/publisher/base.js'
import Signer from '../lib/signer/base.js'
import Source from '../lib/source/base.js'
import Transport from '../lib/transport/noop.js'
import { PublishMetrics, countZones } from '../lib/metrics.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function zoneMap(spec) {
  return new Map(
    Object.entries(spec).map(([apex, count]) => [
      apex,
      {
        zone: { zone: apex },
        records: Array.from({ length: count }, (_, i) => ({ id: i })),
      },
    ]),
  )
}

class StubSource extends Source {
  constructor(zones, delay = 0) {
    super()
    this.zones = zones
    this.delay = delay
  }
  async getZones() {
    if (this.delay) await sleep(this.delay)
    return this.zones
  }
}

class StubPublisher extends Publisher {
  constructor({ delay = 0, artifacts = { kind: 'stub' } } = {}) {
    super()
    this.delay = delay
    this.artifacts = artifacts
  }
  async publish() {
    if (this.delay) await sleep(this.delay)
    return this.artifacts
  }
}

const build = (opts) =>
  new Nameserver({
    id: 1,
    name: 'ns1.example.com.',
    type: 'stub',
    transport: new Transport({ interval: 0 }),
    ...opts,
  })

describe('countZones', () => {
  it('sums records across zones', () => {
    assert.deepEqual(countZones(zoneMap({ 'a.com': 3, 'b.com': 2 })), {
      zoneCount: 2,
      recordCount: 5,
    })
  })

  it('treats a non-Map as empty rather than throwing', () => {
    assert.deepEqual(countZones(null), { zoneCount: 0, recordCount: 0 })
    assert.deepEqual(countZones([]), { zoneCount: 0, recordCount: 0 })
  })

  it('counts a zone with no records', () => {
    assert.deepEqual(countZones(new Map([['a.com', { zone: {} }]])), {
      zoneCount: 1,
      recordCount: 0,
    })
  })
})

describe('publishCycle metrics', () => {
  it('records counts taken from the source, not the publisher', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 4, 'b.com': 1 })),
      // Reports nothing of its own, as rfc1035 and maradns do.
      publisher: new StubPublisher(),
    })

    await ns.publishCycle()

    const m = ns.status().publish
    assert.equal(m.count, 1)
    assert.equal(m.failures, 0)
    assert.equal(m.last.zoneCount, 2)
    assert.equal(m.last.recordCount, 5)
  })

  it('attributes time to the stage that spent it', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 1 }), 60),
      publisher: new StubPublisher({ delay: 5 }),
    })

    await ns.publishCycle()

    const { stages, durationMs } = ns.status().publish.last
    assert.ok(stages.read >= 50, `read should dominate, got ${stages.read}`)
    assert.ok(stages.read > stages.publish, 'read was the slow stage')
    assert.ok(durationMs >= stages.read, 'total covers its stages')
    assert.ok(stages.sign < 1, `no signer configured, got ${stages.sign}ms`)
  })

  it('accumulates count, min, max and average across cycles', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 1 })),
      publisher: new StubPublisher(),
    })

    await ns.publishCycle()
    await ns.publishCycle()
    await ns.publishCycle()

    const m = ns.status().publish
    assert.equal(m.count, 3)
    assert.ok(m.durationMs.min <= m.durationMs.avg)
    assert.ok(m.durationMs.avg <= m.durationMs.max)
    assert.deepEqual(Object.keys(m.avgStageMs), ['read', 'publish', 'sign', 'deliver'])
  })

  it('surfaces records a publisher had to skip', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 3 })),
      publisher: new StubPublisher({
        artifacts: { kind: 'powerdns-db', skipped: [{ owner: 'x' }, { owner: 'y' }] },
      }),
    })

    await ns.publishCycle()
    assert.equal(ns.status().publish.last.skipped, 2)
  })

  it('blames the failing stage and keeps the successful history', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 1 })),
      publisher: new StubPublisher(),
    })
    await ns.publishCycle()

    class Boom extends Signer {
      async sign() {
        throw new Error('signer not implemented')
      }
    }
    ns.signer = new Boom()

    await assert.rejects(() => ns.publishCycle(), /signer not implemented/)

    const m = ns.status().publish
    assert.equal(m.count, 1, 'the failed cycle is not counted as a success')
    assert.equal(m.failures, 1)
    assert.equal(m.lastFailure.stage, 'sign')
    assert.match(m.lastFailure.message, /signer not implemented/)
    assert.equal(m.last.zoneCount, 1, 'last success is still there')
  })

  it('blames read when the source is what broke', async () => {
    class BadSource extends Source {
      async getZones() {
        throw new Error('ECONNREFUSED')
      }
    }
    const ns = build({ source: new BadSource(), publisher: new StubPublisher() })

    await assert.rejects(() => ns.publishCycle(), /ECONNREFUSED/)
    assert.equal(ns.status().publish.lastFailure.stage, 'read')
  })

  it('reports nulls before the first cycle', () => {
    const m = new PublishMetrics().toJSON()
    assert.equal(m.count, 0)
    assert.equal(m.last, null)
    assert.equal(m.avgStageMs, null)
    assert.deepEqual(m.durationMs, { last: null, avg: null, min: null, max: null })
  })
})

describe('status()', () => {
  it('names the composed pieces so paths are distinguishable', async () => {
    const ns = build({
      source: new StubSource(zoneMap({ 'a.com': 1 })),
      publisher: new StubPublisher(),
    })
    await ns.publishCycle()

    const s = ns.status()
    assert.equal(s.publisher, 'StubPublisher')
    assert.equal(s.transport, 'NoopTransport')
    assert.equal(s.type, 'stub')
  })
})
