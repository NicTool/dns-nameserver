import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import Nameserver from '../lib/base.js'
import MemoryPublisher from '../lib/publisher/memory.js'
import Transport from '../lib/transport/base.js'

class FakeSource extends EventEmitter {
  async getZones() {
    return new Map()
  }
}

function build() {
  return new Nameserver({
    id: 1,
    name: 'ns1.example.com',
    source: new FakeSource(),
    publisher: new MemoryPublisher(),
    transport: new Transport({ interval: 0, cooldown: 0 }),
  })
}

describe('Nameserver', function () {
  it('does not accumulate listeners across start/stop cycles', async () => {
    const ns = build()

    for (let i = 0; i < 3; i++) {
      await ns.start()
      await ns.stop()
    }

    assert.strictEqual(ns.source.listenerCount('zoneChanged'), 0)
    assert.strictEqual(ns.transport.listenerCount('error'), 0)

    await ns.start()
    assert.strictEqual(ns.source.listenerCount('zoneChanged'), 1)
    assert.strictEqual(ns.transport.listenerCount('error'), 1)
    await ns.stop()
  })

  it('does not surface a failed publish as an unhandled rejection', async () => {
    const ns = build()
    const errors = []
    ns.on('error', (err) => errors.push(err))
    await ns.start()

    // the source starts failing only after a clean start
    ns.source.getZones = async () => {
      throw new Error('source is down')
    }

    const rejections = []
    const onRejection = (err) => rejections.push(err)
    process.on('unhandledRejection', onRejection)
    try {
      ns.source.emit('zoneChanged')
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))

      assert.deepStrictEqual(rejections, [], 'the rejection must be swallowed')
      assert.strictEqual(errors.length, 1, "but still reported via 'error'")
      assert.match(errors[0].message, /source is down/)
    } finally {
      process.removeListener('unhandledRejection', onRejection)
      await ns.stop()
    }
  })

  it('names the type in start() errors when name is unset', async () => {
    const ns = new Nameserver({ type: 'bind', publisher: new MemoryPublisher() })
    await assert.rejects(() => ns.start(), /^Error: bind: source is required$/)
  })

  it('falls back to a generic label when nothing identifies it', async () => {
    const ns = new Nameserver({ publisher: new MemoryPublisher() })
    await assert.rejects(() => ns.start(), /^Error: Nameserver: source is required$/)
  })
})
