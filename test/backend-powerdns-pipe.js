// PowerdnsPipeBackend driven in-process, over streams rather than a fork.
//
// The protocol-level behaviour that needs no database lives here; the
// end-to-end run against a real NicTool schema is test/nt-powerdns.js.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import Backend from '../lib/backend/base.js'
import PowerdnsPipeBackend from '../lib/backend/powerdns-pipe.js'

/** Feed the backend some lines and collect what it writes back. */
async function exchange(backend, lines) {
  const input = new PassThrough()
  const output = new PassThrough()

  let out = ''
  output.on('data', (chunk) => (out += chunk))

  const running = backend.run({ input, output })
  for (const line of lines) input.write(line + '\n')
  input.end()

  const ok = await running
  return { ok, lines: out.split('\n').filter(Boolean) }
}

const backend = (opts = {}) => new PowerdnsPipeBackend({ db: { password: 'x' }, ...opts })

describe('Backend', () => {
  it('is abstract', async () => {
    const base = new Backend()

    await assert.rejects(() => base.lookup({}), /not implemented/)
    await assert.rejects(() => base.axfr(1), /not implemented/)
    await assert.rejects(() => base.run(), /not implemented/)
  })

  it('PowerdnsPipeBackend is one', () => {
    assert.ok(backend() instanceof Backend)
  })
})

describe('PowerdnsPipeBackend options', () => {
  it('defaults the database connection', () => {
    const b = backend()

    assert.equal(b.db.host, '127.0.0.1')
    assert.equal(b.db.port, 3306)
    assert.equal(b.db.user, 'nictool')
    assert.equal(b.db.database, 'nictool')
  })

  it('keeps a default when the environment supplied nothing', () => {
    // The CLI passes process.env values straight through, and an unset one is
    // undefined — which a plain spread would write over the default.
    const b = backend({ db: { host: undefined, port: undefined, password: 'x' } })

    assert.equal(b.db.host, '127.0.0.1')
    assert.equal(b.db.port, 3306)
  })

  it('coerces the numeric options a shell hands over as strings', () => {
    const b = backend({ nameserverId: '7', cacheTtl: '90' })

    assert.equal(b.nameserverId, 7)
    assert.equal(b.cacheTtl, 90)
  })
})

describe('PowerdnsPipeBackend protocol', () => {
  it('completes the HELO handshake', async () => {
    const { ok, lines } = await exchange(backend(), ['HELO\t1'])

    assert.equal(ok, true)
    assert.deepEqual(lines, ['OK\tNicTool PowerDNS backend ready'])
  })

  it('answers PING with a bare END', async () => {
    const { lines } = await exchange(backend(), ['HELO\t1', 'PING'])

    assert.deepEqual(lines, ['OK\tNicTool PowerDNS backend ready', 'END'])
  })

  it('rejects a first line that is not HELO', async () => {
    const { ok, lines } = await exchange(backend(), [
      'Q\twww.x.test\tIN\tA\t-1\t127.0.0.1',
    ])

    assert.equal(ok, false, 'the caller exits non-zero on this')
    assert.deepEqual(lines, ['FAIL'])
  })

  it('ends an unknown request rather than dropping the exchange', async () => {
    // PowerDNS waits for END; without one the pipe stalls.
    const { lines } = await exchange(backend(), ['HELO\t1', 'NOSUCHVERB'])

    assert.equal(lines.at(-1), 'END')
  })

  it('ignores blank lines', async () => {
    const { lines } = await exchange(backend(), ['HELO\t1', '', 'PING'])

    assert.deepEqual(lines, ['OK\tNicTool PowerDNS backend ready', 'END'])
  })

  it('reports a failed query as LOG and still ends', async () => {
    // No database here, so the lookup throws — the backend must not take the
    // whole co-process down with it.
    const { lines } = await exchange(
      backend({ db: { host: '127.0.0.1', port: 1, password: 'x' } }),
      ['HELO\t1', 'Q\twww.x.test\tIN\tA\t-1\t127.0.0.1'],
    )

    assert.match(lines.at(-2), /^LOG\tError: /)
    assert.equal(lines.at(-1), 'END')
  })

  it('takes a custom banner', async () => {
    const { lines } = await exchange(backend({ banner: 'custom' }), ['HELO\t1'])

    assert.equal(lines[0], 'OK\tcustom')
  })
})
