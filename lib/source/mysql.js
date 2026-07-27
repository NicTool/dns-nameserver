import mysql from 'mysql2/promise'
import { getMap, unApplyMap } from '@nictool/dns-resource-record'

import Source from './base.js'

const canonical = (name) => String(name).toLowerCase().replace(/\.$/, '')

const ZONE_COLUMNS = `z.nt_zone_id AS id, z.nt_group_id AS gid, z.zone,
       z.mailaddr, z.description, z.serial, z.refresh, z.retry, z.expire,
       z.minimum, z.ttl, z.last_publish`

function parseDsn(dsn) {
  const u = new URL(dsn)
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  }
}

/**
 * MysqlSource – reads zones from the NicTool MySQL store.
 *
 * With a nameserverId, zones are restricted to those assigned to it through
 * nt_zone_nameserver; without one every active zone is returned, matching
 * FileSource. Record type names come from resource_record_type, so this needs
 * no resource-record library of its own.
 *
 * Emits no 'zoneChanged' events — transports poll on their interval.
 */
export class MysqlSource extends Source {
  constructor(opts = {}) {
    super(opts)
    const { dsn, host, port, user, password, database } = opts
    this.connConfig = dsn
      ? parseDsn(dsn)
      : { host, port: port ?? 3306, user, password, database }
    this.pool = null
  }

  async connect() {
    if (!this.pool) {
      this.pool = mysql.createPool({
        ...this.connConfig,
        waitForConnections: true,
        connectionLimit: 4,
        // Serials and TTLs must not arrive as JS floats or Date objects.
        decimalNumbers: true,
        dateStrings: ['DATETIME', 'TIMESTAMP'],
      })
    }
    return this.pool
  }

  async disconnect() {
    const pool = this.pool
    this.pool = null
    await pool?.end()
  }

  async getZones({ nameserverId } = {}) {
    const pool = await this.connect()

    const [zones] = nameserverId
      ? await pool.query(
          `SELECT ${ZONE_COLUMNS}
             FROM nt_zone z
             JOIN nt_zone_nameserver zn ON zn.nt_zone_id = z.nt_zone_id
            WHERE z.deleted = 0 AND zn.nt_nameserver_id = ?`,
          [nameserverId],
        )
      : await pool.query(`SELECT ${ZONE_COLUMNS} FROM nt_zone z WHERE z.deleted = 0`)

    if (!zones.length) return new Map()

    const [records] = await pool.query(
      `SELECT zr.nt_zone_record_id AS id, zr.nt_zone_id AS zid, zr.name AS owner,
              zr.ttl, zr.description, zr.address, zr.weight, zr.priority,
              zr.other, zr.location, t.name AS type
         FROM nt_zone_record zr
         JOIN resource_record_type t ON t.id = zr.type_id
        WHERE zr.deleted = 0 AND zr.nt_zone_id IN (?)`,
      [zones.map((z) => z.id)],
    )

    const byZone = new Map()
    for (const r of records) {
      // NicTool packs every type into the same columns. Translate to the RFC
      // field names so the records match what the file stores hold, and can be
      // handed straight to a resource-record class.
      const map = getMap(r.type)
      if (map) unApplyMap(r, map)
      for (const f of ['weight', 'priority', 'other', 'description', 'location']) {
        if (r[f] === null || r[f] === undefined || r[f] === '') delete r[f]
      }

      if (!byZone.has(r.zid)) byZone.set(r.zid, [])
      byZone.get(r.zid).push(r)
    }

    const out = new Map()
    for (const z of zones) {
      if (!z.zone) continue
      out.set(canonical(z.zone), { zone: z, records: byZone.get(z.id) ?? [] })
    }
    return out
  }
}

export default MysqlSource
