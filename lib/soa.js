import { canonical, ownerFqdn } from './zone-name.js'

/**
 * SOA name fields, as NicTool has always defined them.
 *
 * `nt_zone.mailaddr` is the RNAME — the responsible person
 * The MNAME - the primary nsname - comes from the zone's own NS records.
 */

/** MNAME: the zone's first apex NS record. */
export function soaPrimary(zone, apex, records = []) {
  const ns = records.find(
    (r) =>
      String(r.type ?? '').toUpperCase() === 'NS' &&
      !r.deleted &&
      ownerFqdn(r, apex) === apex,
  )
  if (ns?.dname) return canonical(ns.dname)
  return canonical(zone?.nsname ?? `ns1.${apex}`)
}

/** RNAME: mailaddr, or the conventional default BIND expects. */
export function soaAdmin(zone, apex) {
  return canonical(zone?.mailaddr || `hostmaster.${apex}`)
}
