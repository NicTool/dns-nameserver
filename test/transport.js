import assert from 'node:assert'
import { describe, it } from 'node:test'

import Transport from '../lib/transport/base.js'

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
    await new Promise((r) => setTimeout(r, 150))

    assert.strictEqual(calls, 2, 'rapid notifyChange should coalesce to one extra run')

    // After the window, a fresh change triggers immediately again.
    await new Promise((r) => setTimeout(r, 150))
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
    await new Promise((r) => setTimeout(r, 170))
    await t.stop()
    const after = calls
    assert.ok(calls >= 3, `expected at least 3 ticks, saw ${calls}`)
    await new Promise((r) => setTimeout(r, 100))
    assert.strictEqual(calls, after, 'stop() must cancel further ticks')
  })
})
