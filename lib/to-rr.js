import * as RR from '@nictool/dns-resource-record'

/**
 * Build the resource-record instance for a stored NicTool record, so the
 * record can export itself — toBind(), toTinydns(), toMaraDNS(), toWire().
 *
 * No per-type handling here on purpose: every type @nictool/dns-resource-record
 * supports is publishable, and its exporters already know each rdata format.
 * The Sources hand back records using RFC field names (the file stores hold
 * them that way; MysqlSource translates the NicTool columns), so the record
 * itself is already the constructor's argument.
 *
 * Throws if the type is unknown or the rdata does not validate — callers
 * decide whether that costs one record or the whole zone.
 */
export function toRR(record, owner, ttl) {
  const type = String(record.type ?? '').toUpperCase()
  const Klass = RR[type]
  if (typeof Klass !== 'function') throw new Error(`unsupported record type ${type}`)

  // Storage bookkeeping the RR classes have no field for.
  const fields = { ...record }
  for (const k of ['id', 'zid', 'deleted', 'location', 'description', 'timestamp']) {
    delete fields[k]
  }

  return new Klass({ ...fields, owner, ttl, class: 'IN', type })
}

export default toRR
