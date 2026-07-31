// AxfrServer answers transfers. The authorization question — may this peer
// transfer this zone? — is answered by the assignment that already exists:
// Source.getZones({ nameserverId }) is both "which zones does it serve" and
// "which zones may it pull".
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { Packet } from 'dns2'

import AxfrServer from '../lib/axfr-server.js'
import Source from '../lib/source/base.js'

const A = (owner, address, id) => ({ id, type: 'A', owner, address, ttl: 300 })

/** Zones keyed by nameserver id, so authorization can actually be exercised. */
class AssignedSource extends Source {
  constructor(byNameserver) {
    super()
    this.byNameserver = byNameserver
  }
  async getZones({ nameserverId } = {}) {
    return this.byNameserver.get(nameserverId) ?? new Map()
  }
}

const zone = (apex, records, extra = {}) => [
  apex,
  {
    zone: { zone: apex, ttl: 300, serial: 5, mailaddr: `hostmaster.${apex}`, ...extra },
    records,
  },
]

let server
let port

async function listen(source, nameservers, opts = {}) {
  server = new AxfrServer({
    listen: [{ address: '127.0.0.1', port: 0 }],
    source,
    nameservers,
    ...opts,
  })
  await server.start()
  port = server.addresses()[0].port
  return server
}

beforeEach(() => {
  server = null
})

afterEach(async () => {
  await server?.stop()
})

/** Send one length-prefixed query and collect every response message. */
function transfer(message, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const messages = []
    let buffer = Buffer.alloc(0)
    const done = () => resolve(messages)
    const timer = setTimeout(() => {
      socket.destroy()
      messages.length ? done() : reject(new Error('no response'))
    }, timeoutMs)

    socket.on('connect', () => {
      const framed = Buffer.alloc(2 + message.length)
      framed.writeUInt16BE(message.length, 0)
      message.copy(framed, 2)
      socket.write(framed)
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) break
        const len = buffer.readUInt16BE(0)
        if (buffer.length < 2 + len) break
        messages.push(Packet.parse(buffer.subarray(2, 2 + len)))
        buffer = buffer.subarray(2 + len)
      }
      // A transfer ends with the closing SOA.
      const last = messages[messages.length - 1]
      const answers = messages.flatMap((m) => m.answers)
      if (
        answers.length > 1 &&
        answers[answers.length - 1].type === Packet.TYPE.SOA &&
        last.header.rcode === 0
      ) {
        clearTimeout(timer)
        socket.end()
        done()
      } else if (last.header.rcode !== 0) {
        clearTimeout(timer)
        socket.end()
        done()
      }
    })
    socket.on('error', reject)
  })
}

function query(name, type) {
  const packet = new Packet()
  packet.header.id = 0x4242
  packet.header.rd = 0
  packet.questions.push({ name, type, class: Packet.CLASS.IN })
  return packet.toBuffer()
}

const TYPE_AXFR = 252
const TYPE_IXFR = 251

describe('AxfrServer authorization', () => {
  it('transfers a zone assigned to the requesting peer', async () => {
    await listen(
      new AssignedSource(
        new Map([[1, new Map([zone('mine.example', [A('www', '192.0.2.2', 1)])])]]),
      ),
      [{ id: 1, name: 'ns2.', address: '127.0.0.1' }],
    )

    const messages = await transfer(query('mine.example', TYPE_AXFR))
    const answers = messages.flatMap((m) => m.answers)

    // RFC 5936 §2.2: SOA, the zone, SOA again.
    assert.equal(answers[0].type, Packet.TYPE.SOA)
    assert.equal(answers[answers.length - 1].type, Packet.TYPE.SOA)
    assert.equal(answers.length, 3)
    assert.equal(answers[1].address, '192.0.2.2')
    assert.equal(messages[0].header.aa, 1)
    assert.equal(server.status().transfers, 1)
  })

  it('refuses a peer it does not recognize', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      // Authorized address is someone else, so 127.0.0.1 is unknown.
      [{ id: 1, name: 'ns2.', address: '192.0.2.99' }],
    )

    const [reply] = await transfer(query('mine.example', TYPE_AXFR))
    assert.equal(reply.header.rcode, Packet.RCODE.REFUSED)
    assert.equal(server.status().refusals, 1)
  })

  it('refuses a zone the peer is not assigned', async () => {
    await listen(
      new AssignedSource(
        new Map([[1, new Map([zone('mine.example', [A('@', '192.0.2.1', 1)])])]]),
      ),
      [{ id: 1, name: 'ns2.', address: '127.0.0.1' }],
    )

    const [reply] = await transfer(query('other.example', TYPE_AXFR))
    assert.equal(reply.header.rcode, Packet.RCODE.NOTAUTH)
    assert.equal(reply.answers.length, 0, 'nothing leaks about a zone it may not have')
  })

  it('answers the same for a zone that exists but is not assigned', async () => {
    // Two nameservers, each with its own zone; neither may see the other's.
    await listen(
      new AssignedSource(
        new Map([
          [1, new Map([zone('one.example', [A('@', '192.0.2.1', 1)])])],
          [2, new Map([zone('two.example', [A('@', '192.0.2.2', 2)])])],
        ]),
      ),
      [{ id: 1, name: 'ns1.', address: '127.0.0.1' }],
    )

    const [reply] = await transfer(query('two.example', TYPE_AXFR))
    assert.equal(reply.header.rcode, Packet.RCODE.NOTAUTH)
  })

  it('reports the refusal reason for the operator', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns2.example.', address: '127.0.0.1' }],
    )

    const seen = []
    server.on('refused', (d) => seen.push(d))
    await transfer(query('nope.example', TYPE_AXFR))

    assert.equal(seen.length, 1)
    assert.equal(seen[0].reason, 'zone not assigned')
    assert.equal(seen[0].nameserver, 'ns2.example.')
    assert.equal(seen[0].zone, 'nope.example')
  })

  it('matches a peer by any of its configured addresses', async () => {
    await listen(
      new AssignedSource(new Map([[7, new Map([zone('mine.example', [])])]])),
      [
        {
          id: 7,
          name: 'ns.',
          address: '192.0.2.50',
          listen: [{ address: '127.0.0.1', port: 53 }],
        },
      ],
    )

    const messages = await transfer(query('mine.example', TYPE_AXFR))
    assert.equal(messages[0].header.rcode, 0, 'a listen address authorizes too')
  })
})

describe('AxfrServer transfer behaviour', () => {
  it('falls back to a full transfer for IXFR', async () => {
    await listen(
      new AssignedSource(
        new Map([[1, new Map([zone('mine.example', [A('a', '192.0.2.1', 1)])])]]),
      ),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )

    const answers = (await transfer(query('mine.example', TYPE_IXFR))).flatMap(
      (m) => m.answers,
    )
    assert.equal(answers.length, 3, 'RFC 1995 §4 permits answering IXFR with AXFR')
  })

  it('splits a large zone across several messages, still SOA-bracketed', async () => {
    const records = Array.from({ length: 400 }, (_, i) =>
      A(`h${i}`, `192.0.2.${i % 250}`, i + 1),
    )
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('big.example', records)])]])),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
      { maxMessageSize: 2048 },
    )

    const messages = await transfer(query('big.example', TYPE_AXFR))
    const answers = messages.flatMap((m) => m.answers)

    assert.ok(messages.length > 1, `expected several messages, got ${messages.length}`)
    assert.equal(answers.length, records.length + 2)
    assert.equal(answers[0].type, Packet.TYPE.SOA)
    assert.equal(answers[answers.length - 1].type, Packet.TYPE.SOA)
    for (const m of messages)
      assert.equal(m.header.aa, 1, 'every message is authoritative')
  })

  it('refuses the whole zone rather than sending it incomplete', async () => {
    // A type the wire encoder cannot produce. Dropping it would leave the
    // secondary authoritative for a zone missing records.
    await listen(
      new AssignedSource(
        new Map([
          [
            1,
            new Map([
              zone('mine.example', [
                A('a', '192.0.2.1', 1),
                {
                  id: 2,
                  type: 'SSHFP',
                  owner: 'h',
                  algorithm: 1,
                  fptype: 1,
                  fingerprint: 'ab',
                },
              ]),
            ]),
          ],
        ]),
      ),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )

    const errors = []
    server.on('error', (e) => errors.push(e))

    const [reply] = await transfer(query('mine.example', TYPE_AXFR))
    assert.equal(reply.header.rcode, Packet.RCODE.SERVFAIL)
    assert.equal(reply.answers.length, 0)
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /cannot encode SSHFP/)
    assert.match(errors[0].message, /refusing the transfer/)
  })

  it('answers an unsupported qtype with NOTIMP', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )

    const [reply] = await transfer(query('mine.example', Packet.TYPE.MX))
    assert.equal(reply.header.rcode, Packet.RCODE.NOTIMP)
  })
})

describe('AxfrServer SOA over UDP', () => {
  function udpQuery(message, { timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4')
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('no UDP response'))
      }, timeoutMs)
      socket.on('message', (buf) => {
        clearTimeout(timer)
        socket.close()
        resolve(Packet.parse(buf))
      })
      socket.send(message, port, '127.0.0.1')
    })
  }

  it('answers the serial check a secondary makes before transferring', async () => {
    await listen(
      new AssignedSource(
        new Map([[1, new Map([zone('mine.example', [], { serial: 99 })])]]),
      ),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )

    const reply = await udpQuery(query('mine.example', Packet.TYPE.SOA))
    assert.equal(reply.header.rcode, 0)
    assert.equal(reply.answers[0].type, Packet.TYPE.SOA)
    assert.equal(reply.answers[0].serial, 99, 'the serial is what it came for')
  })

  it('tells a secondary that tried AXFR over UDP, rather than timing out', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )

    const reply = await udpQuery(query('mine.example', TYPE_AXFR))
    assert.equal(
      reply.header.rcode,
      Packet.RCODE.NOTIMP,
      'RFC 5936 §4.2 forbids UDP AXFR',
    )
  })

  it('applies the same authorization to the UDP path', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns.', address: '192.0.2.99' }],
    )

    const reply = await udpQuery(query('mine.example', Packet.TYPE.SOA))
    assert.equal(reply.header.rcode, Packet.RCODE.REFUSED)
  })
})

describe('AxfrServer lifecycle', () => {
  it('requires a source', async () => {
    const s = new AxfrServer({ listen: [{ address: '127.0.0.1', port: 0 }] })
    await assert.rejects(() => s.start(), /source is required/)
  })

  it('reports its counters', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )
    assert.equal(server.status().state, 'running')
    assert.equal(server.status().authorized, 1)

    await transfer(query('mine.example', TYPE_AXFR))
    await transfer(query('nope.example', TYPE_AXFR))

    assert.equal(server.status().transfers, 1)
    assert.equal(server.status().refusals, 1)
  })

  it('releases both sockets on stop, so the port is reusable', async () => {
    await listen(
      new AssignedSource(new Map([[1, new Map([zone('mine.example', [])])]])),
      [{ id: 1, name: 'ns.', address: '127.0.0.1' }],
    )
    const taken = port
    await server.stop()
    server = null

    const probe = net.createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(taken, '127.0.0.1', resolve)
    })
    await new Promise((r) => probe.close(r))
  })
})
