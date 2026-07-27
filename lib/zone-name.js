import path from 'node:path'

/** Lowercase, no trailing dot — the form zone maps are keyed by. */
export const canonical = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/\.$/, '')

/**
 * Resolve a record's owner to a fully qualified name.
 *
 * `owner` is the API's name for a record's left-hand side (see
 * @nictool/validate). It may be '@' or empty for the apex, already qualified,
 * or a label relative to the zone.
 */
export function ownerFqdn(record, apex) {
  const name = canonical(record.owner)
  if (!name || name === '@') return apex
  if (name === apex || name.endsWith('.' + apex)) return name
  return `${name}.${apex}`
}

/**
 * A zone name safe to use as a file name, or to write into a shared data file.
 *
 * Zone names reach here from the store, which a person may have hand-edited, so
 * a separator would escape the output directory and a control character would
 * inject lines into a file covering every zone.
 */
export function safeFileName(zoneName, publisher) {
  const name = String(zoneName ?? '').replace(/\.$/, '')
  const unsafe =
    !name ||
    name === '.' ||
    name === '..' ||
    name !== path.basename(name) ||
    /[/\\\0]/.test(name) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f]/.test(name)
  if (unsafe) {
    throw new Error(`${publisher}: unsafe zone name ${JSON.stringify(zoneName)}`)
  }
  return name
}
