import { soaAdmin, soaPrimary } from './soa.js'
import { toRR } from './to-rr.js'

/**
 * NicTool record -> PowerDNS rdata, for both the gmysql publisher and the
 * nt-powerdns pipe backend.
 *
 * PowerDNS keeps the priority of MX and SRV out of the rdata — a `prio` column
 * in gmysql, its own tab-delimited field in pipe protocol v1 — so both need the
 * same split, and it lives here rather than in either.
 */

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Types whose first rdata field is a priority PowerDNS keeps in its own column
 * (gmysql `prio`) or protocol field (pipe v1), rather than in the rdata.
 */
const PRIO_TYPES = new Set(['MX', 'SRV'])

/** A bare trailing dot is stripped from unquoted names; "." itself is the root. */
const unqualify = (token) =>
  token.startsWith('"') || token.length < 2 ? token : token.replace(/\.$/, '')

/**
 * Drop one layer of character-string quoting. The gmysql backend stores TXT
 * content quoted, as the presentation format has it; the pipe backend expects
 * it raw and quotes it itself, so sending quotes there would double them.
 */
const unquote = (token) =>
  token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1).replace(/\\(["\\])/g, '$1')
    : token

/**
 * @returns {{ content: string, prio: number|null }} `prio` is null for types
 *   PowerDNS does not prioritize, which stores as NULL rather than 0.
 */
export function powerdnsRdata(record, owner = 'x.', ttl = 0, { quoted = true } = {}) {
  const type = String(record.type ?? '').toUpperCase()

  // toBind() gives "owner ttl class type rdata..."; PowerDNS content is the
  // rdata. Going through the library means every type it knows is publishable.
  const fields = toRR(record, owner, ttl).toBind().trimEnd().split('\t')
  let rdata = fields.slice(4).map(unqualify)
  if (!quoted) rdata = rdata.map(unquote)

  if (PRIO_TYPES.has(type)) {
    const [prio, ...rest] = rdata
    return { content: rest.join(' '), prio: num(prio) }
  }
  return { content: rdata.join(' '), prio: null }
}

/**
 * PowerDNS stores the SOA as an ordinary record whose content is the seven
 * fields in order. NicTool keeps them as columns on the zone, so it is
 * synthesized here exactly as the native engine synthesizes its own.
 */
export function powerdnsSoa(zone, apex, records = []) {
  return [
    soaPrimary(zone, apex, records),
    soaAdmin(zone, apex),
    num(zone?.serial, 1),
    num(zone?.refresh, 86400),
    num(zone?.retry, 7200),
    num(zone?.expire, 1209600),
    num(zone?.minimum, 3600),
  ].join(' ')
}
