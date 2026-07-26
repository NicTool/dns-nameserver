import Source from './base.js'

/**
 * MysqlSource – reads zones from the NicTool MySQL store:
 *   SELECT * FROM nt_zone_nameserver WHERE nt_nameserver_id = ?
 *   then joins nt_zone + nt_zone_record for each.
 *
 * Scaffolded — defers until a shared DB client module is agreed upon with
 * the API package. When implemented, it should emit 'zoneChanged' off a
 * polling or LISTEN/NOTIFY mechanism so event-mode transports work.
 */
export class MysqlSource extends Source {
  constructor(opts = {}) {
    super()
    this.opts = opts
  }

  async connect() {
    throw new Error('MysqlSource is not yet implemented')
  }

  async getZones() {
    throw new Error('MysqlSource is not yet implemented')
  }
}

export default MysqlSource
