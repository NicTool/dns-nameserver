import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import Source from './base.js'
import { withAssignedNs } from './assigned-ns.js'

// FSEvents (macOS) starts a directory watch asynchronously and drops changes
// made before its stream is live, so connect() rechecks the files after this.
const WATCH_START_MS = 500

const canonical = (name) => String(name).toLowerCase().replace(/\.$/, '')

// smol-toml is loaded only for a TOML store, so a JSON deployment is dependency-free.
const codecs = {
  json: { ext: 'json', parse: async (str) => JSON.parse(str) },
  toml: { ext: 'toml', parse: async (str) => (await import('smol-toml')).parse(str) },
}

/** The size and mtime of each named file, as one comparable string. */
async function fileStamps(dir, names) {
  const stamps = await Promise.all(
    [...names].map((name) =>
      fs.stat(path.join(dir, name)).then(
        (st) => `${st.size}:${st.mtimeMs}`,
        () => 'absent',
      ),
    ),
  )
  return stamps.join(' ')
}

/**
 * FileSource reads the NicTool file store layout, one file per entity:
 *   <path>/zone.<ext>         (id, zone, ttl, serial, nameservers, ...)
 *   <path>/zone_record.<ext>  (id, zid, type, owner, + that type's rdata)
 *   <path>/nameserver.<ext>   (id, name, ttl: a zone's assigned apex NS)
 *
 * Records hold RFC field names, not NicTool's overloaded columns: an MX has
 * `preference` and `exchange`, not `weight` and `address`. Only MysqlSource
 * translates, because only the NicTool schema packs rdata into shared columns.
 *
 * `format` selects the codec — json (default) or toml.
 *
 * Filters out soft-deleted rows. A zone's `nameservers` holds the ids of the
 * nameservers assigned to it, as nt_zone_nameserver does for MysqlSource.
 */
export class FileSource extends Source {
  constructor({ path: storePath, format = 'json', settleMs = 150 } = {}) {
    super()
    this.path = storePath || process.env.NICTOOL_DATA_STORE_PATH || './data'
    this.codec = codecs[format] ?? codecs.json
    this.settleMs = settleMs
    this._watcher = null
    this._settleTimer = null
    this._startTimer = null
  }

  get watches() {
    return this._watcher !== null
  }

  /**
   * Watch the store directory rather than the files: the API writes through
   * a temp file and renames, which breaks a watch bound to the original inode,
   * and the files may not exist yet on a fresh install.
   */
  async connect() {
    if (this._watcher) return
    const names = new Set(
      ['zone', 'zone_record', 'nameserver'].map((base) => `${base}.${this.codec.ext}`),
    )
    try {
      // Watch the resolved path, never the one we were handed: Windows reports
      // changes under the long name, and libuv aborts the process outright when
      // that does not prefix-match the directory it was given. A store under an
      // 8.3 path (C:\Users\RUNNER~1\...) or a symlink is enough to trip it.
      const dir = await fs.realpath(this.path)
      const before = await fileStamps(dir, names)
      let sawEvent = false
      this._watcher = watch(dir, (_event, filename) => {
        if (filename && !names.has(path.basename(filename))) return
        sawEvent = true
        this._settle()
      })
      this._watcher.on('error', () => this._stopWatching())
      this._startTimer = setTimeout(async () => {
        this._startTimer = null
        const after = await fileStamps(dir, names)
        if (!sawEvent && this._watcher && after !== before) this._settle()
      }, WATCH_START_MS)
    } catch {
      // No directory yet, or the platform refuses to watch it. Event mode is
      // unavailable; `watches` reports false so the caller can say so.
      this._watcher = null
    }
  }

  async disconnect() {
    this._stopWatching()
  }

  // One save produces several fs events, and a rename shows up as two. Collapse
  // them so a single edit is a single zoneChanged.
  //
  // Neither this timer nor the watcher is unref'd: an unref'd pair lets the loop
  // idle out with a change still pending, dropping the publish it was about to
  // trigger. disconnect() is the shutdown path, and it closes both.
  _settle() {
    if (this._settleTimer) clearTimeout(this._settleTimer)
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null
      this.notifyZoneChanged({ source: 'file', path: this.path })
    }, this.settleMs)
  }

  _stopWatching() {
    clearTimeout(this._startTimer)
    this._startTimer = null
    if (this._settleTimer) {
      clearTimeout(this._settleTimer)
      this._settleTimer = null
    }
    this._watcher?.close()
    this._watcher = null
  }

  async getZones({ nameserverId } = {}) {
    const zones = await this._loadTable('zone', 'zone')
    const records = await this._loadTable('zone_record', 'zone_record')
    const nameservers = new Map(
      (await this._loadTable('nameserver', 'nameserver'))
        .filter((n) => !n.deleted)
        .map((n) => [n.id, n]),
    )

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
      const assigned = (z.nameservers ?? []).map(Number).sort((a, b) => a - b)
      if (nameserverId != null && !assigned.includes(Number(nameserverId))) continue

      const active = assigned.map((id) => nameservers.get(id)).filter(Boolean)
      out.set(canonical(z.zone), {
        zone: z,
        records: withAssignedNs(z, byZone.get(z.id) ?? [], active),
      })
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
