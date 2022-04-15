
import fs     from 'fs/promises'

import { fullPath, valueCleanup } from '../index.js'

export default {
  getZones,
}

export async function getZones (filePath, basePath) {
  const buf = await fs.readFile(filePath)
  const r = parseConfig(buf.toString())
  const s = new Map()
  r.zone.map(z => s.set(z.domain.toLowerCase(), fullPath(basePath, z.file)))
  return s
}

export function parseConfig (str) {

  const re = {
    // fixed "top" level sections
    topOpen: /^(acl|control|database|key|keystore|module|policy|remote|server|submission|template|zone|log):\s*?$/,
    key_val: /^[ \t]+([^\s]+?):\s*([^\r\n#]+?)\s*(#[^\r\n]+)?$/,
    arrItem: /^[ \t]+-\s+([^\s]+?):\s*([^\r\n#]+?)\s*(#[^\r\n]+)?$/,
    // array  : /^[ \t]+\s+\[[^\]]\]\s*$/,
    blank  : /^\s*?$/,
    comment: /^\s*(?:#)[^\r\n]*?$/,
  }

  const res = {}
  let section = ''
  let inner = {}

  function storeAccumulatedSection () {
    if (res[section] === undefined) res[section] = []
    if (Object.keys(inner).length) res[section].push(inner)
    inner = {}
  }

  for (const line of str.split(/[\r\n]/)) {
    if (re.blank.test(line)) continue
    if (re.comment.test(line)) continue

    const topOpen = line.match(re.topOpen)
    if (topOpen) {
      if (section) storeAccumulatedSection()
      section = topOpen[1]
      continue
    }

    const itemOpen = line.match(re.arrItem)
    if (itemOpen) {
      if (Object.keys(inner).length) storeAccumulatedSection()

      inner[itemOpen[1]] = valueCleanup(itemOpen[2])
      continue
    }

    const setting = line.match(re.key_val)
    if (setting) {
      // array items can be multiple of identical key
      if ([ 'listen', 'address', 'via' ].includes(setting[1])) {
        if (inner[setting[1]] === undefined) inner[setting[1]] = []
        inner[setting[1]].push(valueCleanup(setting[2]))
      }
      else {
        inner[setting[1]] = valueCleanup(setting[2])
      }
    }
    else {
      console.log(line)
      throw ('parser failed')
    }
  }

  if (section) {
    if (res[section] === undefined) res[section] = []
    res[section].push(inner)
  }

  return res
}
