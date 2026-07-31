import { Packet } from 'dns2'

import { soaAdmin, soaPrimary } from './soa.js'
import { canonical } from './zone-name.js'

/**
 * NicTool record -> the plain object shape dns2's rdata encoders read.
 *
 * Shared by NativeNS, which answers queries from it, and AxfrServer, which
 * streams whole zones. A second encoder for the transfer path would drift from
 * the query path, and a zone that answers differently over AXFR than it does
 * over a query is the worst kind of bug to chase.
 *
 * Records arrive with RFC field names (see @nictool/validate and the Sources),
 * most of which dns2 shares; only the name-valued types differ. This cannot
 * defer to @nictool/dns-resource-record's exporters — those emit text, and
 * dns2 encodes from its own object shape.
 *
 * Coverage is whatever dns2 can encode: A, AAAA, CNAME, PTR, NS, MX, TXT, SRV,
 * CAA, plus the synthesized SOA. toResource returns null for anything else, and
 * callers decide what that costs — a query drops the record, a transfer must
 * refuse the zone.
 */

export function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// RFC 7208 §3.1 retired the SPF RR type (99); the policy is published as TXT.
export function wireTypeName(recType) {
  return recType === 'SPF' ? 'TXT' : recType
}

export function soaResource(owner, ttl, zone, apex, records = []) {
  return {
    name: owner,
    type: Packet.TYPE.SOA,
    class: Packet.CLASS.IN,
    ttl,
    primary: soaPrimary(zone, apex, records),
    admin: soaAdmin(zone, apex),
    serial: num(zone?.serial, 1),
    refresh: num(zone?.refresh, 86400),
    retry: num(zone?.retry, 7200),
    expiration: num(zone?.expire, 1209600),
    minimum: num(zone?.minimum, 3600),
  }
}

/**
 * Map a NicTool record onto the plain object shape dns2's rdata encoders read.
 *
 * Records arrive with RFC field names (see @nictool/validate and the Sources),
 * most of which dns2 shares; only the name-valued types differ. Unlike the
 * text publishers, this cannot defer to the library's exporters — dns2 encodes
 * from its own object shape — so it serves the types dns2 can encode and
 * returns null for the rest (NODATA).
 */
// dns2 knows DNSKEY and RRSIG by id but not NSEC/NSEC3/DS. Its encoder falls
// back to writing `resource.data` verbatim for any type it cannot encode, which
// is exactly what a pre-signed record needs.
export const DNSSEC_TYPE_IDS = { RRSIG: 46, NSEC: 47, DNSKEY: 48, DS: 43, NSEC3: 50 }

export function toResource(rec, owner, apex, zone) {
  const ttl = num(rec.ttl ?? zone?.ttl, 3600)
  const type = wireTypeName(String(rec.type ?? '').toUpperCase())

  // Records the signer produced carry their own wire rdata: it is what the
  // signature covers, so re-deriving it here could only introduce a difference.
  if (rec.wireRdata) {
    const typeId = DNSSEC_TYPE_IDS[type] ?? Packet.TYPE[type]
    const signed = { name: owner, type: typeId, class: Packet.CLASS.IN, ttl }
    // dns2 does have a DNSKEY encoder, and it wants the fields, not the bytes.
    if (type === 'DNSKEY') {
      return {
        ...signed,
        flags: rec.flags,
        protocol: rec.protocol,
        algorithm: rec.algorithm,
        key: Buffer.from(rec.publickey ?? '', 'base64').toString('base64'),
      }
    }
    return { ...signed, data: Buffer.from(rec.wireRdata) }
  }

  const base = { name: owner, type: Packet.TYPE[type], class: Packet.CLASS.IN, ttl }

  switch (type) {
    case 'A':
    case 'AAAA':
      return { ...base, address: String(rec.address ?? '') }
    case 'CNAME':
      return { ...base, domain: canonical(rec.cname) }
    case 'PTR':
      return { ...base, domain: canonical(rec.dname) }
    case 'NS':
      return { ...base, ns: canonical(rec.dname) }
    case 'MX':
      return {
        ...base,
        exchange: canonical(rec.exchange),
        priority: num(rec.preference, 10),
      }
    case 'TXT':
      return { ...base, data: String(rec.data ?? '') }
    case 'SRV':
      return {
        ...base,
        target: canonical(rec.target),
        priority: num(rec.priority),
        weight: num(rec.weight),
        port: num(rec.port),
      }
    case 'CAA':
      return {
        ...base,
        flags: num(rec.flags),
        tag: String(rec.tag ?? 'issue'),
        value: String(rec.value ?? ''),
      }
    default:
      return null
  }
}

/**
 * dns2 encodes rdata lazily, at toBuffer() time, so a single unencodable record
 * would otherwise fail the whole response. Encoding it alone first isolates it.
 */
export function encodable(resource) {
  try {
    const probe = new Packet()
    probe.answers.push(resource)
    probe.toBuffer()
    return true
  } catch {
    return false
  }
}

export { Packet }
