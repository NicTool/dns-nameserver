import fs from 'node:fs/promises'
import path from 'node:path'

import Source from './base.js'

const canonical = (name) => String(name).toLowerCase().replace(/\.$/, '')

// smol-toml is loaded only for a TOML store, so a JSON deployment is dependency-free.
const codecs = {
  json: { ext: 'json', parse: async (str) => JSON.parse(str) },
  toml: { ext: 'toml', parse: async (str) => (await import('smol-toml')).parse(str) },
}

/**
 * FileSource reads the NicTool file store layout, one file per entity:
 *   <path>/zone.<ext>         (id, zone, ttl, serial, ...)
 *   <path>/zone_record.<ext>  (id, zid, type, owner, + that type's rdata)
 *   <path>/nameserver.<ext>   (not required here; the supervisor reads it)
 *
 * Records hold RFC field names, not NicTool's overloaded columns: an MX has
 * `preference` and `exchange`, not `weight` and `address`. Only MysqlSource
 * translates, because only the NicTool schema packs rdata into shared columns.
 *
 * `format` selects the codec — json (default) or toml.
 *
 * Filters out soft-deleted rows. Does not (yet) honor nameserver → zone
 * assignment – returns every active zone, since the file store has no
 * junction table. When that's added, filter on nameserverId here.
 */
export class FileSource extends Source {
  constructor({ path: storePath, format = 'json' } = {}) {
    super()
    this.path = storePath || process.env.NICTOOL_DATA_STORE_PATH || './data'
    this.codec = codecs[format] ?? codecs.json
  }

  async getZones({ nameserverId: _nameserverId } = {}) {
    const zones = await this._loadTable('zone', 'zone')
    const records = await this._loadTable('zone_record', 'zone_record')

    const byZone = new Map()
    for (const r of records) {
      if (r.deleted) continue
      if (!byZone.has(r.zid)) byZone.set(r.zid, [])
      byZone.get(r.zid).push(r)
    }

    const out = new Map()
    for (const z of zones) {
      if (z.deleted) continue
      if (!z.zone) continue
      out.set(canonical(z.zone), { zone: z, records: byZone.get(z.id) ?? [] })
    }
    return out
  }

  async _loadTable(basename, key) {
    const filePath = path.join(this.path, `${basename}.${this.codec.ext}`)
    try {
      const str = await fs.readFile(filePath, 'utf8')
      const data = await this.codec.parse(str)
      return Array.isArray(data?.[key]) ? data[key] : []
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }
}

export default FileSource
