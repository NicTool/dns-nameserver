import { canonical, ownerFqdn } from '../zone-name.js'

const fqdn = (name) => `${canonical(name)}.`

/**
 * NicTool 2 keeps a zone's apex NS set as nameserver assignments, not records,
 * and the lowest-id assignment is the SOA MNAME. The assigned NS records go
 * ahead of the zone's own, where soaPrimary() looks for the MNAME, and replace
 * any stored apex NS record with the same target.
 *
 * @param {object} zone          the zone row
 * @param {object[]} records     the zone's stored records
 * @param {object[]} nameservers the active assigned nameservers, lowest id first
 */
export function withAssignedNs(zone, records, nameservers) {
  const apex = canonical(zone.zone)
  const assigned = nameservers.map((ns) => ({
    zid: zone.id,
    owner: `${apex}.`,
    type: 'NS',
    ttl: ns.ttl ?? zone.ttl,
    dname: fqdn(ns.name),
  }))
  if (assigned.length === 0) return records

  const targets = new Set(assigned.map((r) => r.dname))
  const isAssigned = (r) =>
    String(r.type ?? '').toUpperCase() === 'NS' &&
    ownerFqdn(r, apex) === apex &&
    targets.has(fqdn(r.dname))

  return [...assigned, ...records.filter((r) => !isAssigned(r))]
}

export default withAssignedNs
