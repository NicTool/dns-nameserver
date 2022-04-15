
import fs     from 'fs/promises'

import { fullPath, valueCleanup } from '../index.js'

export default {
  getZones,
}

export async function getZones (filePath, basePath) {
  const buf = await fs.readFile(filePath)
  const r = parseConfig(buf.toString())
  const s = new Map()
  r.zone.map(z => s.set(z.name.toLowerCase(), fullPath(basePath, z.zonefile)))
  return s
}

export function parseConfig (str) {

  const re = {
    top    : /^(key|pattern|remote-control|server|tls-auth|zone):\s*?$/,
    key_val: /^[ \t]+([^\s]+?):\s*([^\r\n#]+?)\s*(#[^\r\n]+)?$/,
    blank  : /^\s*?$/,
    comment: /^\s*(?:#)[^\r\n]*?$/,
  }

  const res = {}
  let topBlock = ''
  let inner = {}

  for (const line of str.split(/[\r\n]/)) {
    if (re.blank.test(line)) continue
    if (re.comment.test(line)) continue

    const top = line.match(re.top)
    if (top) {
      if (topBlock) {
        // store the collected attributes with the top block
        if (res[topBlock] === undefined) res[topBlock] = []
        res[topBlock].push(inner)
        inner = {}
      }
      topBlock = top[1]
      continue
    }

    const match = line.match(re.key_val)
    if (match) {
      inner[match[1]] = valueCleanup(match[2])
    }
    else {
      console.log(line)
      throw ('parser failed')
    }
  }

  if (topBlock) {
    if (res[topBlock] === undefined) res[topBlock] = []
    res[topBlock].push(inner)
  }

  return res
}
