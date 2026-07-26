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
  PTR: 12,
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

// A query carrying an EDNS OPT record advertising `payload` bytes (RFC 6891).
function buildEdnsQuery(name, typeId, payload) {
  const base = buildQuery(name, typeId)
  base.writeUInt16BE(1, 10) // ARCOUNT
  const opt = Buffer.alloc(11)
  opt.writeUInt8(0, 0) // root name
  opt.writeUInt16BE(41, 1) // TYPE OPT
  opt.writeUInt16BE(payload, 3) // CLASS carries the payload size
  return Buffer.concat([base, opt])
}

function readName(buf, offset) {
  const labels = []
  let pos = offset
  let end = -1
  let jumps = 0
  while (pos >= 0 && pos < buf.length) {
    const len = buf[pos]
    if (len === 0) {
      if (end === -1) end = pos + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length || ++jumps > 64) break
      if (end === -1) end = pos + 2
      pos = ((len & 0x3f) << 8) | buf[pos + 1]
      continue
    }
    if (pos + 1 + len > buf.length) break
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
      case TYPE.PTR:
        rec.domain = readName(buf, rdStart).name
        break
      case TYPE.SRV:
        rec.priority = rdata.readUInt16BE(0)
        rec.weight = rdata.readUInt16BE(2)
        rec.port = rdata.readUInt16BE(4)
        rec.target = readName(buf, rdStart + 6).name
        break
      case TYPE.CAA: {
        rec.flags = rdata[0]
        const tagLen = rdata[1]
        rec.tag = rdata.subarray(2, 2 + tagLen).toString('ascii')
        rec.value = rdata.subarray(2 + tagLen).toString('utf8')
        break
      }
    }
    answers.push(rec)
  }

  const tc = (flags >> 9) & 1
  return { header: { rcode, aa, tc, qdcount, ancount }, answers, length: buf.length }
}

function udpQuery(name, typeId, opts) {
  return rawSend(buildQuery(name, typeId), opts).then(parseResponse)
}

function rawSend(buf, { port, address = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      reject(new Error('timeout'))
    }, 2000)
    sock.on('message', (msg) => {
      clearTimeout(timer)
      sock.close()
      resolve(msg)
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      sock.close()
      reject(err)
    })
    sock.send(buf, port, address)
  })
}

function malformedQuery(id, ptrHigh, ptrLow) {
  const buf = Buffer.alloc(18)
  buf.writeUInt16BE(id, 0)
  buf.writeUInt16BE(0x0100, 2)
  buf.writeUInt16BE(1, 4)
  buf.writeUInt8(ptrHigh, 12)
  buf.writeUInt8(ptrLow, 13)
  buf.writeUInt16BE(TYPE.A, 14)
  buf.writeUInt16BE(1, 16)
  return buf
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
        { id: 17, zid: 1, type: 'TXT', name: 'utf8', address: 'é'.repeat(200), ttl: 300 },
        {
          id: 18,
          zid: 1,
          type: 'CNAME',
          name: 'toolong',
          address: `${'a'.repeat(70)}.example.com`,
          ttl: 300,
        },
        { id: 19, zid: 1, type: 'A', name: 'bogus', address: 'not.an.ip.addr', ttl: 300 },
        { id: 20, zid: 1, type: 'SPF', name: 'spf', address: 'v=spf1 mx -all', ttl: 300 },
        { id: 21, zid: 1, type: 'SPF', name: 'both', address: 'v=spf1 a -all', ttl: 300 },
        { id: 22, zid: 1, type: 'TXT', name: 'both', address: 'v=spf1 a -all', ttl: 300 },
        {
          id: 23,
          zid: 1,
          type: 'SRV',
          name: '_sip._tcp',
          address: 'sipserver.example.com',
          priority: 10,
          weight: 20,
          port: 5060,
          ttl: 300,
        },
        {
          id: 24,
          zid: 1,
          type: 'CAA',
          name: '@',
          address: 'letsencrypt.org',
          tag: 'issue',
          weight: 0,
          ttl: 300,
        },
        {
          id: 25,
          zid: 1,
          type: 'PTR',
          name: 'ptr',
          address: 'host.example.com',
          ttl: 300,
        },
        // together these overflow a 512-byte UDP response
        ...Array.from({ length: 8 }, (_, i) => ({
          id: 30 + i,
          zid: 1,
          type: 'TXT',
          name: 'big',
          address: 'x'.repeat(200) + i,
          ttl: 300,
        })),
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

  it('answers SRV', async () => {
    const res = await udpQuery('_sip._tcp.example.com', TYPE.SRV, { port })
    assert.strictEqual(res.answers.length, 1)
    const [a] = res.answers
    assert.strictEqual(a.priority, 10)
    assert.strictEqual(a.weight, 20)
    assert.strictEqual(a.port, 5060)
    assert.strictEqual(a.target, 'sipserver.example.com')
  })

  it('answers CAA', async () => {
    const res = await udpQuery('example.com', TYPE.CAA, { port })
    assert.strictEqual(res.answers.length, 1)
    const [a] = res.answers
    assert.strictEqual(a.flags, 0)
    assert.strictEqual(a.tag, 'issue')
    assert.strictEqual(a.value, 'letsencrypt.org')
  })

  it('answers PTR', async () => {
    const res = await udpQuery('ptr.example.com', TYPE.PTR, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].domain, 'host.example.com')
  })

  it('synthesizes SOA at apex when qtype=SOA', async () => {
    const res = await udpQuery('example.com', TYPE.SOA, { port })
    assert.strictEqual(res.answers.length, 1)
    assert.strictEqual(res.answers[0].type, TYPE.SOA)
  })

  it('survives a cyclic compression pointer', async () => {
    await rawSend(malformedQuery(0x1234, 0xc0, 12), { port })
    const res = await udpQuery('example.com', TYPE.A, { port })
    assert.strictEqual(res.answers[0].address, '192.0.2.10')
  })

  it('survives a compression pointer past the end of the packet', async () => {
    await rawSend(malformedQuery(0x1235, 0xc0, 200), { port })
    const res = await udpQuery('example.com', TYPE.A, { port })
    assert.strictEqual(res.answers[0].address, '192.0.2.10')
  })

  it('rejects a label length above 63 rather than accepting a reserved prefix', async () => {
    // the label is fully present, so only the length check can reject it
    const buf = Buffer.alloc(98)
    buf.writeUInt16BE(0x1237, 0)
    buf.writeUInt16BE(0x0100, 2)
    buf.writeUInt16BE(1, 4)
    buf.writeUInt8(0x50, 12) // 80: reserved 0b01 prefix, and > 63
    Buffer.alloc(80, 0x61).copy(buf, 13)
    buf.writeUInt8(0, 93)
    buf.writeUInt16BE(TYPE.A, 94)
    buf.writeUInt16BE(1, 96)

    const res = parseResponse(await rawSend(buf, { port }))
    assert.strictEqual(res.header.rcode, 1, 'expected FORMERR')
  })

  it('omits the question section and QDCOUNT when the query cannot be parsed', async () => {
    const res = parseResponse(await rawSend(malformedQuery(0x1238, 0xc0, 12), { port }))
    assert.strictEqual(res.header.rcode, 1)
    assert.strictEqual(res.header.qdcount, 0, 'QDCOUNT must match the absent question')
    assert.strictEqual(res.length, 12, 'header only, no question section')
  })

  it('echoes the query ID on FORMERR so the client can match the reply', async () => {
    const reply = await rawSend(malformedQuery(0xbeef, 0xc0, 12), { port })
    assert.strictEqual(reply.readUInt16BE(0), 0xbeef)
    assert.strictEqual(parseResponse(reply).header.rcode, 1)
  })

  it('skips a record with a malformed address rather than answering 0.0.0.0', async () => {
    const res = await udpQuery('bogus.example.com', TYPE.A, { port })
    assert.strictEqual(res.answers.length, 0)
    assert.strictEqual(res.header.rcode, 0)
  })

  it('returns FORMERR for a truncated QNAME rather than misreading QTYPE', async () => {
    // label claims 9 bytes but the packet ends after 4
    const buf = Buffer.alloc(21)
    buf.writeUInt16BE(0x1236, 0)
    buf.writeUInt16BE(0x0100, 2)
    buf.writeUInt16BE(1, 4)
    buf.writeUInt8(9, 12)
    Buffer.from('abcd').copy(buf, 13)

    const res = parseResponse(await rawSend(buf, { port }))
    assert.strictEqual(res.header.rcode, 1, 'expected FORMERR')
  })

  it('skips a record whose label exceeds 63 bytes instead of emitting a wrapped length', async () => {
    const res = await udpQuery('toolong.example.com', TYPE.CNAME, { port })
    assert.strictEqual(res.answers.length, 0)
    assert.strictEqual(res.header.rcode, 0)
  })

  it('answers an SPF-typed record to a TXT query (RFC 7208)', async () => {
    const res = await udpQuery('spf.example.com', TYPE.TXT, { port })
    assert.strictEqual(res.answers[0].type, TYPE.TXT)
    assert.match(String(res.answers[0].data), /v=spf1 mx -all/)
  })

  it('collapses SPF and TXT records that encode to identical wire data', async () => {
    const res = await udpQuery('both.example.com', TYPE.TXT, { port })
    assert.strictEqual(res.answers.length, 1, 'the same TXT must not be sent twice')
  })

  it('answers a multi-byte TXT value', async () => {
    const res = await udpQuery('utf8.example.com', TYPE.TXT, { port })
    assert.strictEqual(res.header.rcode, 0)
    assert.strictEqual(res.answers.length, 1)
  })

  it('sets TC instead of sending an oversized UDP response', async () => {
    const res = parseResponse(
      await rawSend(buildQuery('big.example.com', TYPE.TXT), { port }),
    )
    assert.ok(res.length <= 512, `response is ${res.length} bytes, over the UDP limit`)
    assert.strictEqual(res.header.tc, 1, 'TC must tell the client to retry over TCP')
    assert.strictEqual(res.header.ancount, 0, 'a truncated reply carries no answers')
  })

  it('sends the full response when the client advertises a larger EDNS buffer', async () => {
    const res = parseResponse(
      await rawSend(buildEdnsQuery('big.example.com', TYPE.TXT, 4096), { port }),
    )
    assert.ok(res.length > 512, 'the full answer set exceeds 512 bytes')
    assert.strictEqual(res.header.tc, 0, 'no truncation within the negotiated budget')
    assert.strictEqual(res.header.ancount, 8)
  })

  it('returns NXDOMAIN for unknown zone', async () => {
    const res = await udpQuery('nope.invalid', TYPE.A, { port })
    assert.strictEqual(res.header.rcode, 3)
  })
})
