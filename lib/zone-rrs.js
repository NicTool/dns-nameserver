import * as RR from '@nictool/dns-resource-record'

import { soaAdmin, soaPrimary } from './soa.js'
import { toRR } from './to-rr.js'
import { canonical, ownerFqdn } from './zone-name.js'

/**
 * Turn a Source's zone into the resource records a publisher exports.
 *
 * This lives here rather than in @nictool/dns-zone because the input shape is
 * NicTool's, not a zone file's: the SOA is carried on the zone row instead of
 * being a record, and rows are soft-deleted.
 */

const num = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback

/**
 * @param {string} zoneName  the zone, with or without a trailing dot
 * @param {object} zone      the zone row: ttl, serial, refresh, mailaddr...
 * @param {object[]} records the zone's records, as a Source returns them
 * @returns {{ rrs: object[], apex: string, defaultTtl: number, errors: object[] }}
 *   `apex` is bare (no trailing dot). `errors` holds the records that could not
 *   be built — one bad record costs itself, not the zone, and each publisher
 *   renders them as comments in its own syntax.
 */
export function zoneToRRs(zoneName, zone, records = []) {
  const apex = canonical(zoneName)
  const defaultTtl = num(zone?.ttl, 3600)

  const rrs = [
    new RR.SOA({
      owner: `${apex}.`,
      ttl: defaultTtl,
      class: 'IN',
      mname: `${soaPrimary(zone, apex, records)}.`,
      rname: `${soaAdmin(zone, apex)}.`,
      serial: num(zone?.serial, 1),
      refresh: num(zone?.refresh, 86400),
      retry: num(zone?.retry, 7200),
      expire: num(zone?.expire, 1209600),
      minimum: num(zone?.minimum, 3600),
    }),
  ]

  const errors = []
  for (const record of records) {
    if (record.deleted) continue

    const type = String(record.type ?? '').toUpperCase()
    if (type === 'SOA') continue // built above, from the zone row

    const owner = `${ownerFqdn(record, apex)}.`
    try {
      rrs.push(toRR(record, owner, num(record.ttl, defaultTtl)))
    } catch (err) {
      errors.push({ owner, type, message: String(err.message).split('\n')[0] })
    }
  }

  return { rrs, apex, defaultTtl, errors }
}

export default zoneToRRs
