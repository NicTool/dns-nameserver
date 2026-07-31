import { soaAdmin, soaPrimary } from './soa.js'

/**
 * Rdata for the CoreDNS redis plugin (codysnider/coredns-redis).
 *
 * Field names come from the plugin's types.go, not from coredns.io — that page
 * documents `ip4`/`ip6`, `priority` and `host` for A/AAAA, MX and SRV, and the
 * structs say `ip`, `preference` and `target`. Publishing the documented names
 * would unmarshal to zero values with no error anywhere.
 *
 * Every type is an array except SOA, which is a single object. The plugin's
 * Record struct is the whole document stored against one label.
 */

// The nine types the plugin can answer. No PTR, so no reverse zones.
export const COREDNS_TYPES = new Set([
  'A',
  'AAAA',
  'TXT',
  'CNAME',
  'NS',
  'MX',
  'SRV',
  'CAA',
  'SOA',
])

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const withDot = (name) => {
  const s = String(name ?? '')
  return s.endsWith('.') ? s : `${s}.`
}

/**
 * One record → { key, entry }, where key is the lowercase JSON field the plugin
 * reads and entry is that type's object.
 *
 * @throws when the type is one CoreDNS cannot serve, so the caller can report
 *   it as skipped rather than writing a document the plugin ignores.
 */
export function corednsRedisRdata(rec, defaultTtl) {
  const type = String(rec.type ?? '').toUpperCase()
  if (!COREDNS_TYPES.has(type)) {
    throw new Error(`CoreDNS redis cannot serve ${type}`)
  }

  // ttl is `omitempty`, so leaving it off lets the plugin's own default apply.
  const ttl =
    rec.ttl != null && num(rec.ttl) !== num(defaultTtl) ? num(rec.ttl) : undefined
  const base = ttl === undefined ? {} : { ttl }

  switch (type) {
    case 'A':
    case 'AAAA':
      return {
        key: type.toLowerCase(),
        entry: { ...base, ip: String(rec.address ?? '') },
      }
    case 'TXT':
      return { key: 'txt', entry: { ...base, text: String(rec.data ?? '') } }
    case 'CNAME':
      return { key: 'cname', entry: { ...base, host: withDot(rec.cname) } }
    case 'NS':
      return { key: 'ns', entry: { ...base, host: withDot(rec.dname) } }
    case 'MX':
      return {
        key: 'mx',
        entry: {
          ...base,
          host: withDot(rec.exchange),
          preference: num(rec.preference, 10),
        },
      }
    case 'SRV':
      return {
        key: 'srv',
        entry: {
          ...base,
          priority: num(rec.priority),
          weight: num(rec.weight),
          port: num(rec.port),
          target: withDot(rec.target),
        },
      }
    case 'CAA':
      return {
        key: 'caa',
        entry: {
          flag: num(rec.flags),
          tag: String(rec.tag ?? 'issue'),
          value: String(rec.value ?? ''),
        },
      }
    default:
      throw new Error(`CoreDNS redis cannot serve ${type}`)
  }
}

/**
 * NicTool keeps the SOA on the zone row rather than as a record, so synthesize
 * one for the apex document. MBox is capitalized in the plugin's struct tag.
 */
export function corednsRedisSoa(zone, apex, records = []) {
  return {
    ns: withDot(soaPrimary(zone, apex, records)),
    MBox: withDot(soaAdmin(zone, apex)),
    refresh: num(zone?.refresh, 86400),
    retry: num(zone?.retry, 7200),
    expire: num(zone?.expire, 1209600),
    minttl: num(zone?.minimum, 3600),
  }
}

export default { corednsRedisRdata, corednsRedisSoa, COREDNS_TYPES }
