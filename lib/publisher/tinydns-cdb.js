import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { toTinydns } from '@nictool/dns-zone'

import { safeFileName } from '../zone-name.js'
import { zoneToRRs } from '../zone-rrs.js'

import Publisher from './base.js'

const execFileAsync = promisify(execFile)

/**
 * TinydnsCdbPublisher – renders the djbdns `data` file and compiles it to
 * `data.cdb` with tinydns-data.
 *
 * Unlike the zone-file publishers, tinydns has one global data file covering
 * every zone, so a single changed record recompiles the lot.
 *
 * Artifacts shape:
 *   { directory, dataFile, cdbFile, files: [{ path }], zoneCount, recordCount }
 *
 * Set `compile: false` to render without invoking tinydns-data — for when the
 * binary lives on the target host and a Transport does the compiling there.
 */
export class TinydnsCdbPublisher extends Publisher {
  constructor(opts = {}) {
    super(opts)
    this.path = opts.path || './data/tinydns'
    this.compile = opts.compile !== false
    this.tinydnsData = opts.tinydnsData || 'tinydns-data'
  }

  async publish(zones) {
    await fs.mkdir(this.path, { recursive: true })

    const lines = []
    let recordCount = 0
    for (const [apex, { zone, records }] of zones) {
      const rendered = this._renderZone(apex, zone, records)
      recordCount += rendered.count
      lines.push(...rendered.lines)
    }

    const dataFile = path.join(this.path, 'data')
    const tmp = dataFile + '.tmp'
    await fs.writeFile(tmp, lines.join('\n') + '\n')
    await fs.rename(tmp, dataFile)

    const cdbFile = path.join(this.path, 'data.cdb')
    let compiled = false
    if (this.compile) {
      // tinydns-data reads ./data and writes data.cdb, both relative to cwd.
      try {
        await execFileAsync(this.tinydnsData, [], { cwd: this.path })
        compiled = true
      } catch (err) {
        // Its parse errors go to stderr, and are what the operator needs to see.
        throw new Error(
          `tinydns-data failed: ${String(err.stderr || err.message).trim()}`,
          { cause: err },
        )
      }
    }

    const artifacts = {
      kind: 'tinydns-cdb',
      directory: this.path,
      dataFile,
      cdbFile: compiled ? cdbFile : null,
      files: compiled ? [{ path: dataFile }, { path: cdbFile }] : [{ path: dataFile }],
      zoneCount: zones.size,
      recordCount,
      compiled,
    }
    this.emit('published', artifacts)
    return artifacts
  }

  _renderZone(zoneName, zone, records) {
    // Every zone shares one data file, so a control character in a zone name
    // would inject lines into it rather than just spoiling its own file.
    safeFileName(zoneName, 'TinydnsCdbPublisher')

    const { rrs, apex, errors } = zoneToRRs(zoneName, zone, records)
    const comments = errors.map((e) => `# ${e.owner} ${e.type}: ${e.message}`)

    const lines = [`# ${apex}`, ...toTinydns(rrs).trimEnd().split('\n'), ...comments]
    return { lines, count: rrs.length }
  }
}

export default TinydnsCdbPublisher
