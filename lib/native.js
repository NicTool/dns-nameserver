import { createTCPServer, createUDPServer, Packet } from 'dns2'

import Nameserver from './base.js'
import MemoryPublisher from './publisher/memory.js'
import { encodable, num, soaResource, toResource, wireTypeName } from './wire.js'
import { canonical, ownerFqdn } from './zone-name.js'

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
    super({ ...opts, type: 'native' })
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
    const apex = canonical(zone?.zone ?? '')
    const seen = new Set()
    // RFC 4035 §3.2.1: signatures travel only when the client asks for them.
    const wantsDnssec = dnssecRequested(request)
    const answeredTypes = new Set()

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

      const key = `${wireType}|${JSON.stringify(resource)}`
      if (seen.has(key)) continue
      seen.add(key)
      answeredTypes.add(Packet.TYPE[wireType] ?? resource.type)
      response.answers.push(resource)
    }

    if (wantsDnssec && response.answers.length) {
      // One RRSIG per RRset answered, matched by the type it covers.
      for (const rec of records) {
        if (rec.deleted) continue
        if (String(rec.type ?? '').toUpperCase() !== 'RRSIG') continue
        if (ownerFqdn(rec, apex) !== qname) continue
        if (!answeredTypes.has(rec.typeCovered)) continue

        const resource = toResource(rec, qname, apex, zone)
        if (resource && encodable(resource)) response.answers.push(resource)
      }
    }

    // Synthesize or surface SOA at apex for qtype=SOA or qtype=ANY with no answers
    if (
      qname === apex &&
      (qtype === Packet.TYPE.SOA ||
        (qtype === Packet.TYPE.ANY && response.answers.length === 0))
    ) {
      const soaRec = records.find(
        (r) => !r.deleted && String(r.type ?? '').toUpperCase() === 'SOA',
      )
      const ttl = num(soaRec?.ttl ?? zone?.ttl, 3600)
      const soa =
        zone || soaRec ? soaResource(apex, ttl, zone ?? soaRec, apex, records) : null
      if (soa && encodable(soa)) {
        response.answers.push(soa)
        if (wantsDnssec) {
          for (const rec of records) {
            if (String(rec.type ?? '').toUpperCase() !== 'RRSIG') continue
            if (rec.typeCovered !== Packet.TYPE.SOA) continue
            if (ownerFqdn(rec, apex) !== qname) continue
            const sig = toResource(rec, qname, apex, zone)
            if (sig && encodable(sig)) response.answers.push(sig)
          }
        }
      }
    }

    return response
  }
}

/**
 * The DO bit — RFC 3225 — is bit 15 of the OPT record's TTL field, which dns2
 * surfaces as a type 41 additional. Without it a validating resolver still
 * works; it just gets no signatures to check.
 */
function dnssecRequested(request) {
  for (const additional of request.additionals ?? []) {
    if (additional.type !== Packet.TYPE.EDNS) continue
    if (additional.do === true || additional.DO === true) return true
    const ttl = Number(additional.ttl ?? 0)
    if (((ttl >>> 15) & 1) === 1) return true
  }
  return false
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
