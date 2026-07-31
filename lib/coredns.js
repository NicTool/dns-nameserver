import fs from 'fs/promises'

import { fullPath } from '../index.js'

/**
 * CoreDNS Corefile reader — the counterpart to toCorefileConfig().
 *
 * A Corefile is a list of server blocks. The block header names the zones the
 * block answers for, and plugin directives sit inside:
 *
 *   example.com:53 {
 *       file example.com.zone
 *       transfer {
 *           to 192.0.2.53
 *       }
 *   }
 *
 * Only what NicTool needs to round-trip is modelled: the header, `file`, and
 * nested plugin blocks kept as raw lines. CoreDNS has ~40 plugins and no
 * schema, so anything else is preserved rather than interpreted.
 */

export default {
  getZones,
}

export async function getZones(filePath, basePath) {
  const buf = await fs.readFile(filePath)
  const parsed = parseConfig(buf.toString())
  const zones = new Map()

  for (const block of parsed.server) {
    // The `file` plugin may name its own zones; otherwise the block header's do.
    const names = block.file?.zones?.length ? block.file.zones : block.zones
    if (!block.file) continue
    for (const name of names) {
      zones.set(stripPort(name).toLowerCase(), fullPath(basePath, block.file.path))
    }
  }
  return zones
}

const stripPort = (name) => String(name).replace(/:\d+$/, '')

/** `file DBFILE [ZONES...]` */
const fileArgs = ([path, ...zones]) => ({ path, zones })

// Corefile comments run from # to end of line. No quoting rules apply to the
// directives NicTool writes, so a plain cut is enough.
const stripComment = (line) => line.replace(/#.*$/, '')

export function parseConfig(str) {
  const server = []
  let block = null
  // Corefile plugins can open their own brace block; anything nested is kept
  // verbatim rather than parsed, so an unrecognized plugin cannot break import.
  let nested = null

  for (const raw of str.split(/[\r\n]/)) {
    const line = stripComment(raw).trim()
    if (!line) continue

    if (nested) {
      if (line === '}') {
        block.plugins.push(nested)
        nested = null
      } else {
        nested.lines.push(line)
      }
      continue
    }

    if (!block) {
      const header = line.match(/^(.*?)\{$/)
      if (!header) throw new Error(`Corefile: expected a server block, got "${line}"`)
      const zones = header[1].trim().split(/\s+/).filter(Boolean)
      if (!zones.length) throw new Error('Corefile: server block names no zone')
      block = { zones, plugins: [] }
      continue
    }

    if (line === '}') {
      server.push(block)
      block = null
      continue
    }

    const opening = line.match(/^(\S+)(.*?)\{$/)
    if (opening) {
      const args = opening[2].trim().split(/\s+/).filter(Boolean)
      // `file` may open a block of its own for `reload`, so read its arguments
      // here too — descending first would lose the zone file entirely.
      if (opening[1] === 'file') block.file = fileArgs(args)
      nested = { name: opening[1], args, lines: [] }
      continue
    }

    const [name, ...args] = line.split(/\s+/)
    if (name === 'file') block.file = fileArgs(args)
    block.plugins.push({ name, args, lines: [] })
  }

  if (nested || block) throw new Error('Corefile: unclosed block')
  return { server }
}
