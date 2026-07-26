import Publisher from './base.js'

const canonical = (name) => String(name).toLowerCase().replace(/\.$/, '')

/**
 * MemoryPublisher – keeps the current zone map in-process for NativeNS.
 *
 * publish() replaces the live map atomically. findZone(qname) returns the
 * best-matching (longest suffix) zone for a query, so a query for
 * "www.example.com" matches the "example.com" zone even when a narrower zone
 * like "internal.example.com" also exists.
 */
export class MemoryPublisher extends Publisher {
  constructor(opts = {}) {
    super(opts)
    this.zones = new Map()
  }

  async publish(zones) {
    const next = new Map()
    for (const [name, body] of zones) {
      next.set(canonical(name), body)
    }
    this.zones = next
    const artifacts = { kind: 'memory', zoneCount: next.size }
    this.emit('published', artifacts)
    return artifacts
  }

  getZone(name) {
    return this.zones.get(canonical(name)) ?? null
  }

  findZone(qname) {
    const norm = canonical(qname)
    let bestName = null
    for (const name of this.zones.keys()) {
      if (norm === name || norm.endsWith('.' + name)) {
        if (bestName === null || name.length > bestName.length) bestName = name
      }
    }
    return bestName ? this.zones.get(bestName) : null
  }
}

export default MemoryPublisher
