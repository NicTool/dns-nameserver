import { createSocket } from 'node:dgram'
import { createServer as createTCPServer } from 'node:net'

import Nameserver from './base.js'
import MemoryPublisher from './publisher/memory.js'

// ── Constants ─────────────────────────────────────────────────────────────────

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
  ANY: 255,
}

const CLASS_IN = 1
const RCODE_NOERROR = 0
const RCODE_FORMERR = 1
const RCODE_NXDOMAIN = 3

// ── Wire helpers ──────────────────────────────────────────────────────────────

/**
 * Read a (possibly pointer-compressed) DNS name from a Buffer.
 * Returns { name: string, end: number } where end is the offset after the name
 * in the original buffer (not following any pointer).
 */
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

/**
 * Encode a domain name to uncompressed wire format.
 */
function writeName(name) {
  if (!name || name === '.') return Buffer.from([0])
  const clean = String(name).replace(/\.$/, '')
  const labels = clean.split('.')
  const bufs = labels.map((l) => {
    const b = Buffer.from(l, 'ascii')
    return Buffer.concat([Buffer.from([b.length]), b])
  })
  return Buffer.concat([...bufs, Buffer.from([0])])
}

function writeIPv4(addr) {
  return Buffer.from(String(addr).split('.').map(Number))
}

function writeIPv6(addr) {
  const groups = expandIPv6(String(addr)).split(':')
  const out = Buffer.allocUnsafe(16)
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i], 16), i * 2)
  return out
}

function expandIPv6(addr) {
  if (!addr.includes('::')) return addr
  const [left, right] = addr.split('::')
  const lp = left ? left.split(':') : []
  const rp = right ? right.split(':') : []
  const fill = Array(8 - lp.length - rp.length).fill('0')
  return [...lp, ...fill, ...rp].join(':')
}

function buildRR(name, typeId, ttl, rdata) {
  const nameBytes = writeName(name)
  const out = Buffer.allocUnsafe(nameBytes.length + 10 + rdata.length)
  nameBytes.copy(out, 0)
  let o = nameBytes.length
  out.writeUInt16BE(typeId, o)
  o += 2
  out.writeUInt16BE(CLASS_IN, o)
  o += 2
  out.writeUInt32BE(ttl >>> 0, o)
  o += 4
  out.writeUInt16BE(rdata.length, o)
  o += 2
  rdata.copy(out, o)
  return out
}

// ── RDATA encoders ────────────────────────────────────────────────────────────

const rdataA = (addr) => writeIPv4(addr)
const rdataAAAA = (addr) => writeIPv6(addr)
const rdataCname = (target) => writeName(target)
const rdataNs = (ns) => writeName(ns)
const rdataPtr = (ptr) => writeName(ptr)

function rdataMx(priority, exchange) {
  const pref = Buffer.allocUnsafe(2)
  pref.writeUInt16BE(Number(priority))
  return Buffer.concat([pref, writeName(exchange)])
}

function rdataTxt(text) {
  const str = String(text)
  const chunks = []
  let rem = str
  while (rem.length > 255) {
    const c = Buffer.from(rem.slice(0, 255), 'utf8')
    chunks.push(Buffer.concat([Buffer.from([c.length]), c]))
    rem = rem.slice(255)
  }
  const c = Buffer.from(rem, 'utf8')
  chunks.push(Buffer.concat([Buffer.from([c.length]), c]))
  return Buffer.concat(chunks)
}

function rdataSoa(z, apex) {
  const mname = writeName(z.mailaddr ?? z.nsname ?? `ns1.${apex}`)
  const rname = writeName(z.rname ?? `hostmaster.${apex}`)
  const tail = Buffer.allocUnsafe(20)
  tail.writeUInt32BE(Number(z.serial ?? 1), 0)
  tail.writeUInt32BE(Number(z.refresh ?? 86400), 4)
  tail.writeUInt32BE(Number(z.retry ?? 7200), 8)
  tail.writeUInt32BE(Number(z.expire ?? 1209600), 12)
  tail.writeUInt32BE(Number(z.minimum ?? 3600), 16)
  return Buffer.concat([mname, rname, tail])
}

function rdataSrv(priority, weight, port, target) {
  const head = Buffer.allocUnsafe(6)
  head.writeUInt16BE(Number(priority), 0)
  head.writeUInt16BE(Number(weight), 2)
  head.writeUInt16BE(Number(port), 4)
  return Buffer.concat([head, writeName(target)])
}

function rdataCaa(flags, tag, value) {
  const tagBytes = Buffer.from(String(tag), 'ascii')
  const valBytes = Buffer.from(String(value), 'utf8')
  const out = Buffer.allocUnsafe(2 + tagBytes.length + valBytes.length)
  out[0] = Number(flags)
  out[1] = tagBytes.length
  tagBytes.copy(out, 2)
  valBytes.copy(out, 2 + tagBytes.length)
  return out
}

// ── Zone helpers ──────────────────────────────────────────────────────────────

const canonical = (n) =>
  String(n ?? '')
    .toLowerCase()
    .replace(/\.$/, '')

function ownerFqdn(rec, apex) {
  const name = canonical(rec.name ?? '')
  if (!name || name === '@') return apex
  if (name === apex || name.endsWith('.' + apex)) return name
  return `${name}.${apex}`
}

function encodeRecord(rec, owner, apex, zone) {
  const ttl = Number(rec.ttl ?? zone?.ttl ?? 3600)
  const type = String(rec.type ?? '').toUpperCase()
  const addr = rec.address ?? ''

  switch (type) {
    case 'A':
      return buildRR(owner, TYPE.A, ttl, rdataA(addr))
    case 'AAAA':
      return buildRR(owner, TYPE.AAAA, ttl, rdataAAAA(addr))
    case 'CNAME':
      return buildRR(owner, TYPE.CNAME, ttl, rdataCname(addr))
    case 'NS':
      return buildRR(owner, TYPE.NS, ttl, rdataNs(addr))
    case 'PTR':
      return buildRR(owner, TYPE.PTR, ttl, rdataPtr(addr))
    case 'MX':
      return buildRR(owner, TYPE.MX, ttl, rdataMx(rec.weight ?? rec.priority ?? 10, addr))
    case 'TXT':
    case 'SPF':
      return buildRR(owner, TYPE.TXT, ttl, rdataTxt(addr))
    case 'SOA':
      return buildRR(owner, TYPE.SOA, ttl, rdataSoa(rec, apex))
    case 'SRV':
      return buildRR(
        owner,
        TYPE.SRV,
        ttl,
        rdataSrv(rec.priority ?? 0, rec.weight ?? 0, rec.port ?? 0, addr),
      )
    case 'CAA':
      return buildRR(
        owner,
        TYPE.CAA,
        ttl,
        rdataCaa(rec.weight ?? 0, rec.tag ?? 'issue', addr),
      )
    default:
      return null
  }
}

// ── Packet parsing and building ───────────────────────────────────────────────

function parsePacket(buf) {
  if (buf.length < 12) return null
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const qdcount = buf.readUInt16BE(4)
  if (qdcount === 0) return null

  const { name, end } = readName(buf, 12)
  if (end + 4 > buf.length) return null

  const qtype = buf.readUInt16BE(end)
  const questionRaw = buf.subarray(12, end + 4) // QNAME + QTYPE + QCLASS

  return { id, flags, qtype, name, questionRaw }
}

function buildResponse({ id, flags, questionRaw, answers, rcode = RCODE_NOERROR }) {
  const respFlags =
    0x8000 | // QR = 1 (response)
    (flags & 0x7800) | // echo OPCODE
    0x0400 | // AA = 1 (authoritative)
    (flags & 0x0100) | // echo RD
    (rcode & 0xf)
  const header = Buffer.allocUnsafe(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(respFlags, 2)
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(answers.length, 6) // ANCOUNT
  header.writeUInt16BE(0, 8) // NSCOUNT
  header.writeUInt16BE(0, 10) // ARCOUNT
  return Buffer.concat([header, questionRaw, ...answers])
}

function buildError(id, flags, questionRaw, rcode) {
  return buildResponse({
    id,
    flags,
    questionRaw: questionRaw ?? Buffer.alloc(0),
    answers: [],
    rcode,
  })
}

// ── NativeNS ───────────────────────────────────────────────────────────────────

/**
 * NativeNS – authoritative in-process DNS server.
 *
 * Dependency-free: uses node:dgram (UDP) and node:net (TCP) with a hand-rolled
 * wire codec. Requires a MemoryPublisher; answers are assembled directly from
 * the publisher's in-process zone map.
 *
 * Supported qtypes: A, AAAA, CNAME, MX, NS, TXT, SOA, PTR, SRV, CAA.
 * All other types return NOERROR with an empty answer set (NODATA).
 */
export class NativeNS extends Nameserver {
  constructor(opts = {}) {
    super({ ...opts, engine: 'native' })
    if (!(this.publisher instanceof MemoryPublisher)) {
      throw new Error('NativeNS requires a MemoryPublisher')
    }
    this._servers = []
  }

  async start() {
    await super.start()
    for (const l of this.listen) {
      const proto = (l.proto ?? 'udp').toLowerCase()
      const address = l.address ?? '127.0.0.1'
      const port = l.port ?? 53

      if (proto === 'udp') {
        const srv = createSocket('udp4')
        srv.on('message', (msg, rinfo) => {
          try {
            const resp = this.handleQuery(msg)
            srv.send(resp, rinfo.port, rinfo.address)
          } catch (err) {
            this.emit('error', err)
          }
        })
        srv.on('error', (err) => this.emit('error', err))
        await bindUDP(srv, port, address)
        this._servers.push(srv)
      } else if (proto === 'tcp') {
        const srv = createTCPServer((sock) => {
          let pending = Buffer.alloc(0)
          sock.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk])
            while (pending.length >= 2) {
              const msgLen = pending.readUInt16BE(0)
              if (pending.length < 2 + msgLen) break
              const msg = pending.subarray(2, 2 + msgLen)
              pending = pending.subarray(2 + msgLen)
              try {
                const resp = this.handleQuery(msg)
                const len = Buffer.allocUnsafe(2)
                len.writeUInt16BE(resp.length)
                sock.write(Buffer.concat([len, resp]))
              } catch (err) {
                this.emit('error', err)
              }
            }
          })
          sock.on('error', (err) => this.emit('error', err))
        })
        srv.on('error', (err) => this.emit('error', err))
        await listenTCP(srv, port, address)
        this._servers.push(srv)
      } else {
        throw new Error(`NativeNS: unsupported proto "${proto}"`)
      }
    }
  }

  async stop() {
    await Promise.all(
      this._servers.map(
        (s) =>
          new Promise((resolve) => {
            try {
              s.close(() => resolve())
            } catch {
              resolve()
            }
          }),
      ),
    )
    this._servers = []
    await super.stop()
  }

  boundAddresses() {
    return this._servers.map((s) =>
      typeof s.address === 'function' ? s.address() : null,
    )
  }

  handleQuery(buf) {
    const parsed = parsePacket(buf)
    if (!parsed) return buildError(0, 0, null, RCODE_FORMERR)

    const { id, flags, qtype, name, questionRaw } = parsed
    const qname = canonical(name)
    const zoneEntry = this.publisher.findZone(name)

    if (!zoneEntry) {
      return buildError(id, flags, questionRaw, RCODE_NXDOMAIN)
    }

    const { zone, records } = zoneEntry
    const apex = canonical(zone?.name ?? '')
    const answers = []
    const seen = new Set()

    for (const rec of records) {
      if (rec.deleted) continue
      const owner = ownerFqdn(rec, apex)
      if (owner !== qname) continue

      const recType = String(rec.type ?? '').toUpperCase()
      if (recType === 'SOA') continue // synthesized below

      const typeMatch = qtype === TYPE.ANY || recType === typeIdToName(qtype)
      if (!typeMatch) continue

      const encoded = encodeRecord(rec, owner, apex, zone)
      if (!encoded) continue

      const key = `${recType}|${rec.address}|${rec.weight ?? ''}|${rec.priority ?? ''}|${rec.tag ?? ''}|${rec.port ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      answers.push(encoded)
    }

    // Synthesize or surface SOA at apex for qtype=SOA or qtype=ANY with no answers
    if (
      qname === apex &&
      (qtype === TYPE.SOA || (qtype === TYPE.ANY && answers.length === 0))
    ) {
      const soaRec = records.find((r) => String(r.type ?? '').toUpperCase() === 'SOA')
      if (soaRec) {
        answers.push(encodeRecord(soaRec, apex, apex, zone))
      } else if (zone) {
        answers.push(
          buildRR(apex, TYPE.SOA, Number(zone.ttl ?? 3600), rdataSoa(zone, apex)),
        )
      }
    }

    return buildResponse({ id, flags, questionRaw, answers })
  }
}

export default NativeNS

// ── Bind helpers ──────────────────────────────────────────────────────────────

function bindUDP(socket, port, address) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, address, () => {
      socket.removeListener('error', reject)
      resolve()
    })
  })
}

function listenTCP(server, port, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

// ── Type ID lookup ────────────────────────────────────────────────────────────

const TYPE_BY_ID = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]))

function typeIdToName(id) {
  return TYPE_BY_ID[id] ?? ''
}
