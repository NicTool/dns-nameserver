import assert from 'node:assert'
import { describe, it } from 'node:test'

import RsyncTransport from '../lib/transport/rsync.js'
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

  it('rejects a start() without a pull function, naming the argument', async () => {
    const t = new Transport({ interval: 0 })
    const expected = { name: 'TypeError', message: /pullAndDeliver function is required/ }
    await assert.rejects(() => t.start(), expected)
    await assert.rejects(() => t.start('nope'), expected)
  })

  it('cancels a pending cooldown timer when a later change runs immediately', async () => {
    let calls = 0
    // long cooldown so the armed timer cannot fire on its own during the test
    const t = new Transport({ interval: 0, cooldown: 10 })
    await t.start(async () => {
      calls += 1
      return {}
    })
    assert.strictEqual(calls, 1)

    await t.notifyChange()
    assert.ok(t._cooldownTimer, 'a deferred run should be armed')
    assert.strictEqual(calls, 1)

    // the window elapsing while that timer is still pending is the state a
    // lagging event loop produces; the immediate run must cancel it
    t._lastRun = Date.now() - 11_000
    await t.notifyChange()

    assert.strictEqual(calls, 2)
    assert.strictEqual(t._cooldownTimer, null, 'the stale timer must be cleared')
    await t.stop()
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

describe('RsyncTransport', function () {
  it('terminates option parsing before the operands', () => {
    const argv = new RsyncTransport({ remote: 'user@host:/zones' }).buildArgs(
      '/tmp/zones',
    )
    const sep = argv.indexOf('--')
    assert.ok(sep !== -1, 'expected a -- operand terminator')
    assert.deepStrictEqual(argv.slice(sep + 1), ['/tmp/zones/', 'user@host:/zones'])
  })

  it('does not let a leading-dash remote become an option', () => {
    const argv = new RsyncTransport({ remote: '--dry-run' }).buildArgs('/tmp/zones')
    const sep = argv.indexOf('--')
    assert.ok(sep !== -1, 'expected a -- operand terminator')
    assert.ok(
      argv.indexOf('--dry-run') > sep,
      '--dry-run must appear only after the terminator',
    )
  })

  it('quotes an ssh key path containing shell metacharacters', () => {
    const argv = new RsyncTransport({
      remote: 'user@host:/zones',
      sshKey: '/tmp/k;touch /tmp/pwned',
    }).buildArgs('/tmp/zones')
    assert.strictEqual(argv[argv.indexOf('-e') + 1], `ssh -i '/tmp/k;touch /tmp/pwned'`)
  })

  it('uses a bare ssh command when no key is configured', () => {
    const argv = new RsyncTransport({ remote: 'user@host:/zones' }).buildArgs(
      '/tmp/zones',
    )
    assert.strictEqual(argv[argv.indexOf('-e') + 1], 'ssh')
  })
})
