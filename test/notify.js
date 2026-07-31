// NOTIFY is hand-encoded, so the bytes are checked against RFC 1996 rather
// than against whatever the encoder happens to produce.
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { describe, it, beforeEach, afterEach } from 'node:test'

import {
  decodeResponse,
  encodeName,
  encodeNotify,
  parseTarget,
  sendNotify,
} from '../lib/notify.js'

describe('encodeName', () => {
  it('emits length-prefixed labels ending in a root byte', () => {
    assert.deepEqual(
      [...encodeName('a.example.com')],
      [1, 0x61, 7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0],
    )
  })

  it('treats a trailing dot as the same name', () => {
    assert.deepEqual([...encodeName('example.com.')], [...encodeName('example.com')])
  })

  it('rejects a label over 63 bytes', () => {
    assert.throws(() => encodeName(`${'x'.repeat(64)}.com`), /63 bytes/)
  })

  it('rejects a name over 255 bytes', () => {
    const long = Array.from({ length: 10 }, () => 'x'.repeat(50)).join('.')
    assert.throws(() => encodeName(long), /255 bytes/)
  })
})

describe('encodeNotify', () => {
  it('sets opcode 4 and AA, with one question and no other sections', () => {
    const buf = encodeNotify({ id: 0x1234, zone: 'example.com' })

    assert.equal(buf.readUInt16BE(0), 0x1234, 'id')
    const flags = buf.readUInt16BE(2)
    assert.equal((flags >> 15) & 1, 0, 'QR=0, this is a request')
    assert.equal((flags >> 11) & 0x0f, 4, 'opcode NOTIFY')
    assert.equal((flags >> 10) & 1, 1, 'AA set')
    assert.equal(flags & 0x0f, 0, 'rcode 0')

    assert.equal(buf.readUInt16BE(4), 1, 'QDCOUNT')
    assert.equal(buf.readUInt16BE(6), 0, 'ANCOUNT')
    assert.equal(buf.readUInt16BE(8), 0, 'NSCOUNT')
    assert.equal(buf.readUInt16BE(10), 0, 'ARCOUNT')
  })

  it('asks for the zone SOA in class IN', () => {
    const buf = encodeNotify({ id: 1, zone: 'example.com' })
    const nameLen = encodeName('example.com').length
    assert.equal(buf.readUInt16BE(12 + nameLen), 6, 'QTYPE SOA')
    assert.equal(buf.readUInt16BE(12 + nameLen + 2), 1, 'QCLASS IN')
    assert.equal(buf.length, 12 + nameLen + 4, 'no trailing sections')
  })
})

describe('decodeResponse', () => {
  it('reads the header and names the rcode', () => {
    const buf = Buffer.alloc(12)
    buf.writeUInt16BE(0xabcd, 0)
    buf.writeUInt16BE(0x8000 | (4 << 11) | 5, 2) // QR=1, NOTIFY, REFUSED
    const res = decodeResponse(buf)
    assert.equal(res.id, 0xabcd)
    assert.equal(res.qr, 1)
    assert.equal(res.opcode, 4)
    assert.equal(res.rcodeName, 'REFUSED')
  })

  it('rejects a truncated message', () => {
    assert.throws(() => decodeResponse(Buffer.alloc(4)), /short DNS message/)
  })
})

describe('parseTarget', () => {
  it('defaults the port', () => {
    assert.deepEqual(parseTarget('10.0.0.1'), { address: '10.0.0.1', port: 53 })
  })

  it('reads an explicit port', () => {
    assert.deepEqual(parseTarget('10.0.0.1:5353'), { address: '10.0.0.1', port: 5353 })
  })

  it('leaves a bare IPv6 literal intact', () => {
    assert.deepEqual(parseTarget('2001:db8::1'), { address: '2001:db8::1', port: 53 })
  })

  it('reads a bracketed IPv6 port', () => {
    assert.deepEqual(parseTarget('[2001:db8::1]:5353'), {
      address: '2001:db8::1',
      port: 5353,
    })
  })

  it('accepts an object', () => {
    assert.deepEqual(parseTarget({ address: 'ns2.example.com', port: 1053 }), {
      address: 'ns2.example.com',
      port: 1053,
    })
  })

  it('rejects an empty target', () => {
    assert.throws(() => parseTarget(''), /needs an address/)
  })
})

describe('sendNotify', () => {
  let server
  let port
  let received

  beforeEach(async () => {
    received = []
    server = dgram.createSocket('udp4')
    await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  afterEach(() => {
    try {
      server.close()
    } catch {
      /* already closed */
    }
  })

  const replyWith = (rcode) => {
    server.on('message', (msg, rinfo) => {
      received.push(msg)
      const res = Buffer.alloc(12)
      res.writeUInt16BE(msg.readUInt16BE(0), 0)
      res.writeUInt16BE(0x8000 | (4 << 11) | rcode, 2)
      server.send(res, rinfo.port, rinfo.address)
    })
  }

  it('resolves ok on NOERROR', async () => {
    replyWith(0)
    const res = await sendNotify({ zone: 'example.com', address: '127.0.0.1', port })

    assert.equal(res.ok, true)
    assert.equal(res.rcode, 'NOERROR')
    assert.equal(res.zone, 'example.com')
    assert.equal(received.length, 1)
    assert.equal(decodeResponse(received[0]).opcode, 4)
  })

  it('reports a refusal without throwing', async () => {
    replyWith(5)
    const res = await sendNotify({ zone: 'example.com', address: '127.0.0.1', port })
    assert.equal(res.ok, false)
    assert.match(res.error, /REFUSED/)
  })

  it('retries a silent server and gives up with a reason', async () => {
    server.on('message', (msg) => received.push(msg))
    const res = await sendNotify({
      zone: 'example.com',
      address: '127.0.0.1',
      port,
      timeoutMs: 40,
      attempts: 3,
    })

    assert.equal(res.ok, false)
    assert.match(res.error, /no response after 3 attempt/)
    assert.equal(received.length, 3, 'one datagram per attempt')
  })

  it('ignores a reply whose id does not match', async () => {
    server.on('message', (msg, rinfo) => {
      received.push(msg)
      const res = Buffer.alloc(12)
      res.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0)
      res.writeUInt16BE(0x8000, 2)
      server.send(res, rinfo.port, rinfo.address)
    })

    const res = await sendNotify({
      zone: 'example.com',
      address: '127.0.0.1',
      port,
      timeoutMs: 40,
      attempts: 1,
    })
    assert.equal(res.ok, false, 'a mismatched id is not our answer')
  })
})
