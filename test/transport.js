import assert from 'node:assert'
import { describe, it } from 'node:test'

import Transport from '../lib/transport/base.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`waitFor timed out: ${label}`)
}

describe('Transport', function () {
  it('interval=0 with cooldown coalesces rapid notifyChange calls', async () => {
    let calls = 0
    const t = new Transport({ interval: 0, cooldown: 0.1 })
    await t.start(async () => {
      calls += 1
      return { ok: true, call: calls }
    })
    assert.strictEqual(calls, 1) // start() triggers one run

    // Fire three rapid changes within the cooldown window.
    // All three should coalesce into exactly one deferred run.
    t.notifyChange()
    t.notifyChange()
    await t.notifyChange()

    await waitFor(() => calls === 2, 'deferred run to fire')
    await sleep(200)
    assert.strictEqual(calls, 2, 'rapid notifyChange should coalesce to one extra run')

    // After the window, a fresh change triggers immediately again.
    await t.notifyChange()
    assert.strictEqual(calls, 3)

    await t.stop()
  })

  it('interval>0 schedules periodic runs and stop() cancels', async () => {
    let calls = 0
    const t = new Transport({ interval: 0.05 })
    await t.start(async () => {
      calls += 1
      return {}
    })
    await waitFor(() => calls >= 3, 'at least 3 periodic ticks')
    await t.stop()
    const after = calls
    await sleep(200)
    assert.strictEqual(calls, after, 'stop() must cancel further ticks')
  })

  it('serialises overlapping publish cycles', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    const t = new Transport({ interval: 0, cooldown: 0 })
    await t.start(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls += 1
      await sleep(20)
      active -= 1
      return {}
    })

    await Promise.all([t.notifyChange(), t.notifyChange(), t.notifyChange()])

    assert.strictEqual(maxActive, 1, 'publish cycles must not overlap')
    assert.ok(calls >= 1)
    await t.stop()
  })
})
