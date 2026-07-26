import { EventEmitter } from 'node:events'

/**
 * Source – abstract reader of NicTool zone truth.
 *
 * Subclasses (TomlSource, MysqlSource) implement getZones() and optionally
 * emit 'zoneChanged' events when the underlying store mutates. Transports
 * running in event mode listen for these to trigger a publish cycle.
 */
export class Source extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
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
