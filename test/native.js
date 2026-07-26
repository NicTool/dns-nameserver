import assert from 'node:assert'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { describe, it, before, after } from 'node:test'

import MemoryPublisher from '../lib/publisher/memory.js'
import NativeNS from '../lib/native.js'
import NoopTransport from '../lib/transport/noop.js'
import Source from '../lib/source/base.js'

// ── Minimal inline DNS wire codec (for test queries only) ────────────────────

const TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
}

function buildQuery(name, typeId) {
  const labels = name.replace(/\.$/, '').split('.')
  const qname = Buffer.concat([
    ...labels.map((l) => {
      const b = Buffer.from(l, 'ascii')
      return Buffer.concat([Buffer.from([b.length]), b])
    }),
    Buffer.from([0]),
  ])
  const buf = Buffer.allocUnsafe(12 + qname.length + 4)
  buf.writeUInt16BE(Math.floor(Math.random() * 65536), 0)
  buf.writeUInt16BE(0x0100, 2) // RD=1
  buf.writeUInt16BE(1, 4) // QDCOUNT
  buf.writeUInt16BE(0, 6)
  buf.writeUInt16BE(0, 8)
  buf.writeUInt16BE(0, 10)
  qname.copy(buf, 12)
  buf.writeUInt16BE(typeId, 12 + qname.length)
  buf.writeUInt16BE(1, 12 + qname.length + 2) // CLASS IN
  return buf
}

function readName(buf, offset) {
  const labels = []
  let pos = offset
  let end = -1
  while (pos < buf.length) {
    const len = buf[pos]
    if (len === 0) {
      if (end === -1) end = pos + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (end === -1) end = pos + 2
      pos = ((len & 0x3f) << 8) | buf[pos + 1]
      continue
    }
    labels.push(
      buf
        .subarray(pos + 1, pos + 1 + len)
        .toString('ascii')
        .toLowerCase(),
    )
    pos += 1 + len
  }
  return { name: labels.join('.'), end: end === -1 ? pos + 1 : end }
}

function formatIPv6(bytes) {
  const groups = []
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  let bestStart = -1,
    bestLen = 0,
    curStart = -1,
    curLen = 0
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === '0') {
      if (curStart === -1) curStart = i
      curLen++
    } else {
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
      curStart = -1
      curLen = 0
    }
  }
  if (bestLen < 2) return groups.join(':')
  const left = groups.slice(0, bestStart).join(':')
  const right = groups.slice(bestStart + bestLen).join(':')
  if (!left && !right) return '::'
  if (!left) return '::' + right
  if (!right) return left + '::'
  return left + '::' + right
}

function parseResponse(buf) {
  const flags = buf.readUInt16BE(2)
  const rcode = flags & 0xf
  const aa = (flags >> 10) & 1
  const qdcount = buf.readUInt16BE(4)
  const ancount = buf.readUInt16BE(6)

  let offset = 12
  for (let i = 0; i < qdcount; i++) {
    const { end } = readName(buf, offset)
    offset = end + 4
  }

  const answers = []
  for (let i = 0; i < ancount; i++) {
    const { end: nameEnd } = readName(buf, offset)
    const typeId = buf.readUInt16BE(nameEnd)
    const rdlen = buf.readUInt16BE(nameEnd + 8)
    const rdStart = nameEnd + 10
    const rdata = buf.subarray(rdStart, rdStart + rdlen)
    offset = rdStart + rdlen

    const rec = { type: typeId }
    switch (typeId) {
      case TYPE.A:
        rec.address = [...rdata].join('.')
        break
      case TYPE.AAAA:
        rec.address = formatIPv6(rdata)
        break
      case TYPE.NS:
        rec.ns = readName(buf, rdStart).name
        break
      case TYPE.CNAME:
        rec.domain = readName(buf, rdStart).name
        break
      case TYPE.MX:
        rec.priority = rdata.readUInt16BE(0)
        rec.exchange = readName(buf, rdStart + 2).name
        break
      case TYPE.TXT:
        rec.data = rdata.subarray(1, 1 + rdata[0]).toString('utf8')
        break
    }
    answers.push(rec)
  }

  return { header: { rcode, aa }, answers }
}

function udpQuery(name, typeId, { port, address = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const buf = buildQuery(name, typeId)
    const sock = createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      reject(new Error('timeout'))
    }, 2000)
    sock.on('message', (msg) => {
      clearTimeout(timer)
      sock.close()
      try {
        resolve(parseResponse(msg))
      } catch (e) {
        reject(e)
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      sock.close()
      reject(err)
    })
    sock.send(buf, port, address)
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// ── Fake Source ───────────────────────────────────────────────────────────────

class FakeSource extends Source {
  constructor(map) {
    super()
    this._map = map
  }
  async getZones() {
    return this._map
  }
}

// ── Test data ─────────────────────────────────────────────────────────────────

const zones = new Map([
  [
    'example.com',
    {
      zone: { id: 1, name: 'example.com', ttl: 300, serial: 2026010101 },
      records: [
        { id: 10, zid: 1, type: 'A', name: '@', address: '192.0.2.10', ttl: 300 },
        { id: 11, zid: 1, type: 'A', name: 'www', address: '192.0.2.20', ttl: 300 },
        { id: 12, zid: 1, type: 'AAAA', name: 'www', address: '2001:db8::1', ttl: 300 },
        {
          id: 13,
          zid: 1,
          type: 'MX',
          name: '@',
          address: 'mail.example.com',
          weight: 10,
          ttl: 300,
        },
        { id: 14, zid: 1, type: 'TXT', name: '@', address: 'v=spf1 -all', ttl: 300 },
        {
          id: 15,
          zid: 1,
          type: 'CNAME',
          name: 'alias',
          address: 'www.example.com',
          ttl: 300,
        },
        { id: 16, zid: 1, type: 'NS', name: '@', address: 'ns1.example.com', ttl: 300 },
      ],
    },
  ],
])

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NativeNS', function () {
  let ns
  let port

  before(async () => {
    port = await freePort()
    ns = new NativeNS({
      id: 1,
      name: 'ns1.example.com.',
      listen: [{ address: '127.0.0.1', port, proto: 'udp' }],
      source: new FakeSource(zones),
      publisher: new MemoryPublisher(),
      transport: new NoopTransport({ interval: 0 }),
    })
    await ns.start()
  })

  after(async () => {
    await ns.stop()
  })

  it('answers A for zone apex', async () => {
    const res = await udpQuery('example.com', TYPE.A, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].address, '192.0.2.10')
    assert.strictEqual(res.header.aa, 1)
  })

  it('answers A for sub-name', async () => {
    const res = await udpQuery('www.example.com', TYPE.A, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].address, '192.0.2.20')
  })

  it('answers AAAA', async () => {
    const res = await udpQuery('www.example.com', TYPE.AAAA, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.match(res.answers[0].address, /^2001:db8::1$/i)
  })

  it('answers MX', async () => {
    const res = await udpQuery('example.com', TYPE.MX, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].exchange, 'mail.example.com')
    assert.strictEqual(res.answers[0].priority, 10)
  })

  it('answers TXT', async () => {
    const res = await udpQuery('example.com', TYPE.TXT, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.match(String(res.answers[0].data), /v=spf1/)
  })

  it('answers CNAME', async () => {
    const res = await udpQuery('alias.example.com', TYPE.CNAME, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].domain, 'www.example.com')
  })

  it('answers NS at apex', async () => {
    const res = await udpQuery('example.com', TYPE.NS, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].ns, 'ns1.example.com')
  })

  it('synthesizes SOA at apex when qtype=SOA', async () => {
    const res = await udpQuery('example.com', TYPE.SOA, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].type, TYPE.SOA)
  })

  it('returns NXDOMAIN for unknown zone', async () => {
    const res = await udpQuery('nope.invalid', TYPE.A, { port })
    assert.strictEqual(res.header.rcode, 3)
  })
})
