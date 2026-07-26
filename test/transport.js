import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  // Shims a fake rsync onto PATH that records the argv it was invoked with.
  async function captureArgs({ remote, sshKey, directory }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-rsync-'))
    const argvFile = path.join(dir, 'argv')
    const bin = path.join(dir, 'rsync')
    await fs.writeFile(
      bin,
      `#!/bin/sh\n: > ${JSON.stringify(argvFile)}\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvFile)}; done\n`,
      { mode: 0o755 },
    )

    const savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath}`
    try {
      const t = new RsyncTransport({ remote, sshKey })
      await t.deliver({ directory })
      return (await fs.readFile(argvFile, 'utf8')).split('\n').filter(Boolean)
    } finally {
      process.env.PATH = savedPath
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('terminates option parsing before the operands', async () => {
    const argv = await captureArgs({
      remote: 'user@host:/zones',
      directory: '/tmp/zones',
    })
    const sep = argv.indexOf('--')
    assert.ok(sep !== -1, 'expected a -- operand terminator')
    assert.deepStrictEqual(argv.slice(sep + 1), ['/tmp/zones/', 'user@host:/zones'])
  })

  it('does not let a leading-dash remote become an option', async () => {
    const argv = await captureArgs({ remote: '--dry-run', directory: '/tmp/zones' })
    const sep = argv.indexOf('--')
    assert.ok(sep !== -1, 'expected a -- operand terminator')
    assert.ok(
      argv.indexOf('--dry-run') > sep,
      '--dry-run must appear only after the terminator',
    )
  })

  it('quotes an ssh key path containing shell metacharacters', async () => {
    const argv = await captureArgs({
      remote: 'user@host:/zones',
      sshKey: '/tmp/k;touch /tmp/pwned',
      directory: '/tmp/zones',
    })
    const e = argv[argv.indexOf('-e') + 1]
    assert.strictEqual(e, `ssh -i '/tmp/k;touch /tmp/pwned'`)
  })
})
