import { EventEmitter } from 'node:events'

/**
 * Source – abstract reader of NicTool zone truth.
 *
 * Subclasses implement getZones(). A source drives event mode by emitting
 * 'zoneChanged'; the Nameserver forwards that to its transport, which
 * coalesces bursts and publishes. Two ways that fires:
 *
 *   - Self-detection: the source notices the store changed on its own.
 *     FileSource watches its files. MysqlSource cannot — see below.
 *   - notifyZoneChanged(): told from outside, by whoever performed the write.
 *
 * Sources that serve queries live from the store need neither; nothing is
 * published, so there is nothing to trigger.
 */
export class Source extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
  }

  /**
   * True when this source detects store changes by itself. A nameserver in
   * event mode whose source returns false will publish once and then wait
   * for an external notifyZoneChanged() that may never arrive.
   */
  get watches() {
    return false
  }

  /** Announce a store change from outside. Drives event mode for any source. */
  notifyZoneChanged(detail) {
    this.emit('zoneChanged', detail)
  }

  async connect() {}
  async disconnect() {}

  /**
   * @param {object} args
   * @param {number} [args.nameserverId]  If set, restricts zones to those
   *   assigned to this nameserver. MySQL sources use the nt_zone_nameserver
   *   junction; TOML/file sources may ignore it and return all active zones.
   * @returns {Promise<Map<string, { zone: object, records: object[] }>>}
   *   Keyed by canonical zone name (no trailing dot).
   */
  async getZones(_args = {}) {
    throw new Error('Source.getZones() not implemented')
  }
}

export default Source
