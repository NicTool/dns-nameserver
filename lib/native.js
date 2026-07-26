import { createTCPServer, createUDPServer, Packet } from 'dns2'

import Nameserver from './base.js'
import MemoryPublisher from './publisher/memory.js'

// ── Zone helpers ──────────────────────────────────────────────────────────────

const canonical = (n) =>
  String(n ?? '')
    .toLowerCase()
    .replace(/\.$/, '')

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function ownerFqdn(rec, apex) {
  const name = canonical(rec.name ?? '')
  if (!name || name === '@') return apex
  if (name === apex || name.endsWith('.' + apex)) return name
  return `${name}.${apex}`
}

// RFC 7208 §3.1 retired the SPF RR type (99); the policy is published as TXT.
function wireTypeName(recType) {
  return recType === 'SPF' ? 'TXT' : recType
}

function soaResource(owner, ttl, zone, apex) {
  return {
    name: owner,
    type: Packet.TYPE.SOA,
    class: Packet.CLASS.IN,
    ttl,
    primary: canonical(zone?.mailaddr ?? zone?.nsname ?? `ns1.${apex}`),
    admin: canonical(zone?.rname ?? `hostmaster.${apex}`),
    serial: num(zone?.serial, 1),
    refresh: num(zone?.refresh, 86400),
    retry: num(zone?.retry, 7200),
    expiration: num(zone?.expire, 1209600),
    minimum: num(zone?.minimum, 3600),
  }
}

/**
 * Map a NicTool record onto the plain object shape dns2's rdata encoders read.
 * Returns null for types this engine does not serve.
 */
function toResource(rec, owner, apex, zone) {
  const ttl = num(rec.ttl ?? zone?.ttl, 3600)
  const type = wireTypeName(String(rec.type ?? '').toUpperCase())
  const addr = rec.address ?? ''
  const base = { name: owner, type: Packet.TYPE[type], class: Packet.CLASS.IN, ttl }

  switch (type) {
    case 'A':
    case 'AAAA':
      return { ...base, address: String(addr) }
    case 'CNAME':
    case 'PTR':
      return { ...base, domain: canonical(addr) }
    case 'NS':
      return { ...base, ns: canonical(addr) }
    case 'MX':
      return {
        ...base,
        exchange: canonical(addr),
        priority: num(rec.weight ?? rec.priority, 10),
      }
    case 'TXT':
      return { ...base, data: String(addr) }
    case 'SOA':
      return soaResource(owner, ttl, zone ?? rec, apex)
    case 'SRV':
      return {
        ...base,
        target: canonical(addr),
        priority: num(rec.priority),
        weight: num(rec.weight),
        port: num(rec.port),
      }
    case 'CAA':
      return {
        ...base,
        flags: num(rec.weight),
        tag: String(rec.tag ?? 'issue'),
        value: String(addr),
      }
    default:
      return null
  }
}

/**
 * dns2 encodes rdata lazily, at toBuffer() time, so a single unencodable record
 * would otherwise fail the whole response. Encoding it alone first isolates it.
 */
function encodable(resource) {
  try {
    const probe = new Packet()
    probe.answers.push(resource)
    probe.toBuffer()
    return true
  } catch {
    return false
  }
}

// ── NativeNS ───────────────────────────────────────────────────────────────────

/**
 * NativeNS – authoritative in-process DNS server.
 *
 * Built on dns2's UDP/TCP servers, which handle framing, EDNS payload-size
 * negotiation and TC-bit truncation. Requires a MemoryPublisher; answers are
 * assembled from the publisher's in-process zone map.
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

      if (proto !== 'udp' && proto !== 'tcp') {
        throw new Error(`NativeNS: unsupported proto "${proto}"`)
      }

      const srv = proto === 'udp' ? createUDPServer() : createTCPServer()
      srv.on('request', (request, respond) => {
        try {
          respond(this.answer(request))
        } catch (err) {
          this.emit('error', err)
        }
      })
      // A message dns2 could not decode far enough to answer: no id to echo,
      // so there is nothing to reply to.
      srv.on('requestError', (err) => this.emit('requestError', err))
      srv.on('error', (err) => this.emit('error', err))
      await listen(srv, port, address)
      this._servers.push(srv)
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

  // Returns a Packet rather than a Buffer so the transport can apply its own
  // sizing rules: UDP sets TC and drops sections when the reply will not fit.
  answer(request) {
    if (request.errors.length || !request.questions.length) {
      return Packet.createErrorResponseFromRequest(request, Packet.RCODE.FORMERR, {
        infoCode: Packet.EDE.INVALID_DATA,
        extraText: request.errors.map((e) => e.message).join('; '),
      })
    }

    const [question] = request.questions
    const qname = canonical(question.name)
    const qtype = question.type
    const zoneEntry = this.publisher.findZone(qname)

    if (!zoneEntry) {
      return Packet.createErrorResponseFromRequest(request, Packet.RCODE.NXDOMAIN)
    }

    const response = Packet.createResponseFromRequest(request)
    response.header.aa = 1

    const { zone, records } = zoneEntry
    const apex = canonical(zone?.name ?? '')
    const seen = new Set()

    for (const rec of records) {
      if (rec.deleted) continue
      const owner = ownerFqdn(rec, apex)
      if (owner !== qname) continue

      const recType = String(rec.type ?? '').toUpperCase()
      if (recType === 'SOA') continue // synthesized below

      const wireType = wireTypeName(recType)
      if (qtype !== Packet.TYPE.ANY && Packet.TYPE[wireType] !== qtype) continue

      const resource = toResource(rec, owner, apex, zone)
      if (!resource || !encodable(resource)) continue

      const key = `${wireType}|${rec.address}|${rec.weight ?? ''}|${rec.priority ?? ''}|${rec.tag ?? ''}|${rec.port ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      response.answers.push(resource)
    }

    // Synthesize or surface SOA at apex for qtype=SOA or qtype=ANY with no answers
    if (
      qname === apex &&
      (qtype === Packet.TYPE.SOA ||
        (qtype === Packet.TYPE.ANY && response.answers.length === 0))
    ) {
      const soaRec = records.find((r) => String(r.type ?? '').toUpperCase() === 'SOA')
      const ttl = num(soaRec?.ttl ?? zone?.ttl, 3600)
      const soa = zone || soaRec ? soaResource(apex, ttl, zone ?? soaRec, apex) : null
      if (soa && encodable(soa)) response.answers.push(soa)
    }

    return response
  }
}

export default NativeNS

// ── Bind helper ───────────────────────────────────────────────────────────────

function listen(server, port, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    Promise.resolve(server.listen(port, address)).then(() => {
      server.removeListener('error', reject)
      resolve()
    }, reject)
  })
}
