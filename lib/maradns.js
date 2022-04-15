
import fs     from 'fs/promises'

import { fullPath, valueCleanup } from '../index.js'

export default {
  getZones,
}

export async function getZones (filePath, basePath) {
  const buf = await fs.readFile(filePath)
  const r = parseConfig(buf.toString())
  const s = new Map()
  for (const z in r) {
    const zf = z.match(/csv2\["(.*)"]/)
    if (zf) {
      s.set(zf[1].toLowerCase(), fullPath(basePath, r[z]))
    }
  }
  return s
}

export function parseConfig (str) {
  // https://maradns.samiam.org/tutorial/man.mararc.html

  const re = {
    blank   : /^\s*?$/,
    comment : /^\s*(?:#)[^\r\n]*?$/,
    variable: /^([^ \t]*)\s*=\s*([^\r\n]*)$/,
  }

  const res = {}

  for (const line of str.split(/[\r\n]/)) {

    if (re.blank.test(line)) continue
    if (re.comment.test(line)) continue

    const match = line.match(re.variable)
    if (match) {
      res[match[1]] = valueCleanup(match[2])
    }
    else {
      console.log(line)
      throw ('parser failed')
    }
  }

  return res
}

