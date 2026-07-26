import fs from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'smol-toml'

import Source from './base.js'

const canonical = (name) => String(name).toLowerCase().replace(/\.$/, '')

/**
 * TomlSource reads the NicTool TOML store layout:
 *   <path>/zone.toml         ([[zone]] entries: id, name, ttl, serial, ...)
 *   <path>/zone_record.toml  ([[zone_record]] entries: id, zid, type, name, address, ...)
 *   <path>/nameserver.toml   (not required here; supervisor reads it)
 *
 * Filters out soft-deleted rows. Does not (yet) honor nameserver → zone
 * assignment – returns every active zone, since the TOML store has no
 * junction table. When that's added, filter on nameserverId here.
 */
export class TomlSource extends Source {
  constructor({ path: storePath } = {}) {
    super()
    this.path = storePath || process.env.NICTOOL_DATA_STORE_PATH || './data'
  }

  async getZones({ nameserverId: _nameserverId } = {}) {
    const zones = await this._loadTable('zone.toml', 'zone')
    const records = await this._loadTable('zone_record.toml', 'zone_record')

    const byZone = new Map()
    for (const r of records) {
      if (r.deleted) continue
      if (!byZone.has(r.zid)) byZone.set(r.zid, [])
      byZone.get(r.zid).push(r)
    }

    const out = new Map()
    for (const z of zones) {
      if (z.deleted) continue
      out.set(canonical(z.name), { zone: z, records: byZone.get(z.id) ?? [] })
    }
    return out
  }

  async _loadTable(filename, key) {
    const filePath = path.join(this.path, filename)
    try {
      const str = await fs.readFile(filePath, 'utf8')
      const data = parse(str)
      return Array.isArray(data[key]) ? data[key] : []
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }
}

export default TomlSource
