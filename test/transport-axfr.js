// AxfrTransport moves no bytes: the publisher already wrote the zone data
// where the primary reads it, and this tells the secondaries to come get it.
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { describe, it, beforeEach, afterEach } from 'node:test'

import AxfrTransport from '../lib/transport/axfr.js'
import { decodeResponse, encodeName } from '../lib/notify.js'
import { extractTsig, signMessage, verifyMessage } from '../lib/tsig.js'

/** A UDP responder that records the zone each NOTIFY asked about. */
async function notifyServer({ rcode = 0, silent = false } = {}) {
  const socket = dgram.createSocket('udp4')
  const zones = []
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))

  socket.on('message', (msg, rinfo) => {
    zones.push(readQuestionName(msg))
    if (silent) return
    const res = Buffer.alloc(12)
    res.writeUInt16BE(msg.readUInt16BE(0), 0)
    res.writeUInt16BE(0x8000 | (4 << 11) | rcode, 2)
    socket.send(res, rinfo.port, rinfo.address)
  })

  return {
    port: socket.address().port,
    zones,
    close: () => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}

function readQuestionName(msg) {
  const labels = []
  let off = 12
  while (msg[off] !== 0) {
    const len = msg[off]
    labels.push(msg.subarray(off + 1, off + 1 + len).toString())
    off += 1 + len
  }
  return labels.join('.')
}

let servers

beforeEach(() => {
  servers = []
})

afterEach(() => {
  for (const s of servers) s.close()
})

const spawn = async (opts) => {
  const s = await notifyServer(opts)
  servers.push(s)
  return s
}

describe('AxfrTransport construction', () => {
  it('requires somewhere to send', () => {
    assert.throws(() => new AxfrTransport({}), /notify is required/)
    assert.throws(() => new AxfrTransport({ notify: [] }), /notify is required/)
  })

  it('accepts the older single master spelling', () => {
    const t = new AxfrTransport({ master: '10.0.0.9' })
    assert.deepEqual(t.targets, [{ address: '10.0.0.9', port: 53 }])
  })

  it('parses a tsigKey up front so a bad one fails fast', () => {
    const secret = Buffer.alloc(32, 1).toString('base64')
    const t = new AxfrTransport({ notify: ['10.0.0.1'], tsigKey: `k1:${secret}` })
    assert.equal(t.tsigKey.name, 'k1')
    assert.equal(t.tsigKey.algorithm, 'hmac-sha256')

    assert.throws(() => new AxfrTransport({ notify: ['10.0.0.1'], tsigKey: 'k' }), /TSIG/)
  })

  it('applies a default port to every target', () => {
    const t = new AxfrTransport({ notify: ['10.0.0.1', '10.0.0.2:5353'], port: 1053 })
    assert.deepEqual(t.targets, [
      { address: '10.0.0.1', port: 1053 },
      { address: '10.0.0.2', port: 5353 },
    ])
  })
})

describe('AxfrTransport deliver', () => {
  it('sends one NOTIFY per zone per target', async () => {
    const a = await spawn()
    const b = await spawn()
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`],
    })

    const res = await t.deliver(
      { kind: 'rfc1035' },
      { zones: ['one.example', 'two.example'] },
    )

    assert.equal(res.ok, true)
    assert.equal(res.zones, 2)
    assert.equal(res.targets, 2)
    assert.equal(res.notified, 4)
    assert.deepEqual(a.zones.sort(), ['one.example', 'two.example'])
    assert.deepEqual(b.zones.sort(), ['one.example', 'two.example'])
  })

  it('takes zone names from the context, since not every publisher names them', async () => {
    const a = await spawn()
    const t = new AxfrTransport({ notify: [`127.0.0.1:${a.port}`] })

    // What powerdns-db and tinydns-cdb produce: counts, no zone names.
    await t.deliver({ kind: 'powerdns-db', zoneCount: 1 }, { zones: ['pdns.example'] })
    assert.deepEqual(a.zones, ['pdns.example'])
  })

  it('falls back to artifact file names without a context', async () => {
    const a = await spawn()
    const t = new AxfrTransport({ notify: [`127.0.0.1:${a.port}`] })

    await t.deliver({
      kind: 'rfc1035',
      files: [{ zone: 'f.example', path: '/x' }, { path: '/named.conf' }],
    })
    assert.deepEqual(a.zones, ['f.example'])
  })

  it('reports a refusing secondary without failing the others', async () => {
    const good = await spawn()
    const bad = await spawn({ rcode: 5 })
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${good.port}`, `127.0.0.1:${bad.port}`],
    })

    const res = await t.deliver({}, { zones: ['x.example'] })

    assert.equal(res.ok, false, 'delivery is not ok if a target refused')
    assert.equal(res.notified, 1)
    assert.equal(res.failures.length, 1)
    assert.match(res.failures[0].error, /REFUSED/)
    assert.equal(res.failures[0].port, bad.port)
  })

  it('surfaces a partial delivery in the publish metrics', async () => {
    const { default: Nameserver } = await import('../lib/base.js')
    const { default: Publisher } = await import('../lib/publisher/base.js')
    const { default: Source } = await import('../lib/source/base.js')

    const bad = await spawn({ rcode: 5 })
    class OneZone extends Source {
      async getZones() {
        return new Map([['x.example', { zone: {}, records: [{ id: 1 }] }]])
      }
    }
    class Nothing extends Publisher {
      async publish() {
        return { kind: 'stub' }
      }
    }

    const ns = new Nameserver({
      id: 1,
      type: 'bind',
      source: new OneZone(),
      publisher: new Nothing(),
      transport: new AxfrTransport({ notify: [`127.0.0.1:${bad.port}`], interval: 0 }),
    })

    await ns.publishCycle()

    const m = ns.status().publish
    // The publish itself succeeded; only a destination refused.
    assert.equal(m.count, 1)
    assert.equal(m.failures, 0)
    assert.equal(m.last.deliveryFailures, 1)
  })

  it('does nothing when no zones were published', async () => {
    const a = await spawn()
    const t = new AxfrTransport({ notify: [`127.0.0.1:${a.port}`] })

    const res = await t.deliver({ kind: 'rfc1035', files: [] }, { zones: [] })
    assert.equal(res.ok, true)
    assert.equal(res.notified, 0)
    assert.match(res.skipped, /no zones/)
    assert.equal(a.zones.length, 0)
  })

  it('does not serialise the wait on an unreachable secondary', async () => {
    const dead = await spawn({ silent: true })
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${dead.port}`],
      timeoutMs: 60,
      attempts: 1,
      concurrency: 8,
    })

    const zones = Array.from({ length: 8 }, (_, i) => `z${i}.example`)
    const started = Date.now()
    const res = await t.deliver({}, { zones })
    const elapsed = Date.now() - started

    assert.equal(res.ok, false)
    assert.equal(res.failures.length, 8)
    // Serially this would be 8 x 60ms; in parallel it is one timeout plus slack.
    assert.ok(elapsed < 300, `expected concurrent sends, took ${elapsed}ms`)
  })

  it('emits a well-formed NOTIFY on the wire', async () => {
    const socket = dgram.createSocket('udp4')
    await new Promise((r) => socket.bind(0, '127.0.0.1', r))
    const seen = new Promise((resolve) => socket.on('message', resolve))

    const t = new AxfrTransport({
      notify: [`127.0.0.1:${socket.address().port}`],
      timeoutMs: 30,
      attempts: 1,
    })
    const deliver = t.deliver({}, { zones: ['wire.example'] })

    const msg = await seen
    const header = decodeResponse(msg)
    assert.equal(header.qr, 0)
    assert.equal(header.opcode, 4)
    assert.equal(header.aa, 1)
    assert.equal(msg.readUInt16BE(4), 1, 'one question')
    const nameLen = encodeName('wire.example').length
    assert.equal(msg.readUInt16BE(12 + nameLen), 6, 'SOA')

    await deliver
    socket.close()
  })
})

describe('AxfrTransport with TSIG', () => {
  const KEY = { name: 'xfr-key', secret: Buffer.alloc(32, 3).toString('base64') }

  /** A secondary that verifies our request and signs its reply over our MAC. */
  async function signingServer({ key = KEY, signReply = true, chain = true } = {}) {
    const socket = dgram.createSocket('udp4')
    const verified = []
    await new Promise((r) => socket.bind(0, '127.0.0.1', r))

    socket.on('message', (msg, rinfo) => {
      const check = verifyMessage({ message: msg, key })
      verified.push(check.ok)

      const header = Buffer.alloc(12)
      header.writeUInt16BE(msg.readUInt16BE(0), 0)
      header.writeUInt16BE(0x8000 | (4 << 11), 2)

      if (!signReply) return socket.send(header, rinfo.port, rinfo.address)

      const requestMac = chain ? extractTsig(msg)?.tsig.mac : null
      const out = signMessage({ message: header, key, requestMac }).message
      socket.send(out, rinfo.port, rinfo.address)
    })

    return {
      port: socket.address().port,
      verified,
      close: () => {
        try {
          socket.close()
        } catch {
          /* already closed */
        }
      },
    }
  }

  it('signs the NOTIFY so the secondary can verify it', async () => {
    const s = await signingServer()
    servers.push(s)
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${s.port}`],
      tsigKey: KEY,
      timeoutMs: 500,
      attempts: 1,
    })

    const res = await t.deliver({}, { zones: ['signed.example'] })

    assert.equal(res.ok, true, JSON.stringify(res.failures))
    assert.deepEqual(s.verified, [true], 'the secondary verified our signature')
  })

  it('rejects an unsigned reply to a signed request', async () => {
    const s = await signingServer({ signReply: false })
    servers.push(s)
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${s.port}`],
      tsigKey: KEY,
      timeoutMs: 500,
      attempts: 1,
    })

    const res = await t.deliver({}, { zones: ['signed.example'] })
    assert.equal(res.ok, false)
    assert.match(res.failures[0].error, /failed TSIG: no TSIG/)
  })

  it('rejects a reply that did not chain to our request MAC', async () => {
    const s = await signingServer({ chain: false })
    servers.push(s)
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${s.port}`],
      tsigKey: KEY,
      timeoutMs: 500,
      attempts: 1,
    })

    const res = await t.deliver({}, { zones: ['signed.example'] })
    assert.equal(res.ok, false, 'an unchained reply is replayable')
    assert.match(res.failures[0].error, /MAC mismatch/)
  })

  it('rejects a reply signed with a different key', async () => {
    const s = await signingServer({
      key: { name: 'xfr-key', secret: Buffer.alloc(32, 9).toString('base64') },
    })
    servers.push(s)
    const t = new AxfrTransport({
      notify: [`127.0.0.1:${s.port}`],
      tsigKey: KEY,
      timeoutMs: 500,
      attempts: 1,
    })

    const res = await t.deliver({}, { zones: ['signed.example'] })
    assert.equal(res.ok, false)
    assert.match(res.failures[0].error, /MAC mismatch/)
  })

  it('rejects a malformed key at construction, not at the first publish', () => {
    assert.throws(
      () => new AxfrTransport({ notify: ['10.0.0.1'], tsigKey: 'no-secret-here' }),
      /TSIG/,
    )
  })
})
