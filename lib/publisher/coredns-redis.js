import { corednsRedisRdata, corednsRedisSoa } from '../coredns-rdata.js'
import { RespClient } from '../resp.js'
import { ownerFqdn } from '../zone-name.js'
import Publisher from './base.js'

/**
 * CorednsRedisPublisher – writes zones for the CoreDNS redis plugin
 * (codysnider/coredns-redis).
 *
 * Layout, read from the plugin rather than its docs page:
 *
 *   key    <keyPrefix><zone.><keySuffix>   a hash, one per zone
 *   field  the label relative to the zone; "@" for the apex
 *   value  a JSON document holding every type for that label, each an array
 *          except SOA
 *
 * The plugin finds its zones by SCANning for that key pattern, so creating the
 * hash is what makes CoreDNS authoritative for the zone. There is no separate
 * index to maintain.
 *
 * Each zone is replaced inside a MULTI, so a query landing mid-publish sees the
 * old contents rather than a half-written zone.
 */
export class CorednsRedisPublisher extends Publisher {
  constructor(opts = {}) {
    super(opts)
    this.address = opts.address || '127.0.0.1:6379'
    this.password = opts.password ?? null
    this.db = opts.db ?? null
    this.keyPrefix = opts.keyPrefix ?? ''
    this.keySuffix = opts.keySuffix ?? ''
    // A very large zone would otherwise become one enormous HSET.
    this.chunkSize = opts.chunkSize ?? 500
    this.client = null
  }

  async connect() {
    if (!this.client) {
      this.client = new RespClient({
        address: this.address,
        password: this.password,
        db: this.db,
      })
      await this.client.connect()
    }
    return this.client
  }

  async disconnect() {
    const client = this.client
    this.client = null
    await client?.quit()
  }

  keyFor(apex) {
    const zone = apex.endsWith('.') ? apex : `${apex}.`
    return `${this.keyPrefix}${zone}${this.keySuffix}`
  }

  async publish(zones) {
    const client = await this.connect()
    const skipped = []
    let recordCount = 0
    let labelCount = 0

    for (const [apex, { zone, records }] of zones) {
      const documents = this._documentsFor(apex, zone, records, skipped)
      recordCount += documents.recordCount
      labelCount += documents.labels.size
      await this._writeZone(client, this.keyFor(apex), documents.labels)
    }

    const artifacts = {
      kind: 'coredns-redis',
      address: this.address,
      zoneCount: zones.size,
      labelCount,
      recordCount,
      skipped,
    }
    this.emit('published', artifacts)
    return artifacts
  }

  /** Map of label → JSON string, one entry per name in the zone. */
  _documentsFor(apex, zone, records, skipped) {
    const defaultTtl = Number(zone?.ttl) || 3600
    const byLabel = new Map()
    let recordCount = 0

    const docFor = (label) => {
      if (!byLabel.has(label)) byLabel.set(label, {})
      return byLabel.get(label)
    }

    // The apex document carries the SOA NicTool keeps on the zone row.
    docFor('@').soa = corednsRedisSoa(zone, apex, records)

    for (const rec of records) {
      if (rec.deleted) continue
      const type = String(rec.type ?? '').toUpperCase()
      if (type === 'SOA') continue

      const label = labelFor(rec, apex)
      try {
        const { key, entry } = corednsRedisRdata(rec, defaultTtl)
        const doc = docFor(label)
        doc[key] = doc[key] ?? []
        doc[key].push(entry)
        recordCount += 1
      } catch (err) {
        skipped.push({ zone: apex, owner: label, type, message: err.message })
      }
    }

    const labels = new Map()
    for (const [label, doc] of byLabel) labels.set(label, JSON.stringify(doc))
    return { labels, recordCount }
  }

  async _writeZone(client, key, labels) {
    const pairs = [...labels.entries()].flat()
    const commands = [['MULTI'], ['DEL', key]]

    for (let i = 0; i < pairs.length; i += this.chunkSize * 2) {
      commands.push(['HSET', key, ...pairs.slice(i, i + this.chunkSize * 2)])
    }
    commands.push(['EXEC'])

    const replies = await client.pipeline(commands)
    const exec = replies[replies.length - 1]
    if (exec === null) throw new Error(`redis MULTI for ${key} was aborted`)
  }
}

/** The label the plugin expects: relative to the zone, "@" at the apex. */
function labelFor(rec, apex) {
  const fqdn = ownerFqdn(rec, apex)
  if (fqdn === apex) return '@'
  return fqdn.endsWith(`.${apex}`) ? fqdn.slice(0, -(apex.length + 1)) : fqdn
}

export default CorednsRedisPublisher
