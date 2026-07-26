import Nameserver from './base.js'

/**
 * FileEngine – covers any nameserver whose role here is to produce
 * artifacts (zone files, CDB, SQL rows) and hand them to a Transport.
 * The actual DNS serving happens in a separate process (bind, knot, nsd,
 * powerdns, tinydns, maradns). This class doesn't bind any sockets.
 *
 * Used as BindNS/KnotNS/NsdNS/PowerdnsNS/TinydnsNS/MaradnsNS — each is just
 * this class with a fixed `engine` identifier.
 */
export class FileEngine extends Nameserver {
  constructor(opts = {}) {
    super(opts)
  }

  async start() {
    if (!this.publisher) {
      throw new Error(`${this.name ?? this.engine}: publisher is required for file engines`)
    }
    await super.start()
  }
}

export class BindNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'bind' }) }
}
export class KnotNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'knot' }) }
}
export class NsdNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'nsd' }) }
}
export class PowerdnsNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'powerdns' }) }
}
export class TinydnsNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'tinydns' }) }
}
export class MaradnsNS extends FileEngine {
  constructor(opts = {}) { super({ ...opts, engine: 'maradns' }) }
}

export default FileEngine
