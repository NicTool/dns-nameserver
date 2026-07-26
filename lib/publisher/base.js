import { EventEmitter } from 'node:events'

/**
 * Publisher – abstract zone emitter.
 *
 * Transforms the Source's canonical zone map into engine-specific artifacts:
 *   - MemoryPublisher: keeps an in-process zone map for NativeNS queries.
 *   - Rfc1035Publisher: writes RFC 1035 zone files to a directory.
 *   - TinydnsCdbPublisher: compiles a data.cdb.
 *   - PowerdnsDbPublisher: writes rows into a PowerDNS SQL backend.
 *
 * publish() returns an "artifacts" object whose shape is defined by the
 * subclass; downstream stages (Signer, Transport) are coupled to their
 * matching Publisher's artifact shape.
 */
export class Publisher extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
  }

  async publish(_zones) {
    throw new Error('Publisher.publish() not implemented')
  }
}

export default Publisher
