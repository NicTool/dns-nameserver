import Nameserver from './base.js'

/**
 * FileEngine – covers any nameserver whose role here is to produce
 * artifacts (zone files, CDB, SQL rows) and hand them to a Transport.
 * The actual DNS serving happens in a separate process (bind, knot, nsd,
 * powerdns, coredns, djbdns, maradns). This class doesn't bind any sockets.
 *
 * Used as BindNS/KnotNS/NsdNS/PowerdnsNS/DjbdnsNS/MaradnsNS — each is just
 * this class with a fixed `type`.
 */
export class FileEngine extends Nameserver {
  constructor(opts = {}) {
    super(opts)
  }

  async start() {
    if (!this.publisher) {
      throw new Error(`${this.name ?? this.type}: publisher is required for file engines`)
    }
    await super.start()
  }
}

export class BindNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'bind' })
  }
}
export class KnotNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'knot' })
  }
}
export class NsdNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'nsd' })
  }
}
export class PowerdnsNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'powerdns' })
  }
}
export class CorednsNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'coredns' })
  }
}
export class DjbdnsNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'djbdns' })
  }
}

/** @deprecated djbdns is the package; tinydns is one of its daemons. */
export class TinydnsNS extends DjbdnsNS {}
export class MaradnsNS extends FileEngine {
  constructor(opts = {}) {
    super({ ...opts, type: 'maradns' })
  }
}

export default FileEngine
