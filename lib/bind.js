// https://bind9.readthedocs.io/en/latest/reference.html

import fs     from 'fs/promises'

import { valueCleanup } from '../index.js'


export async function getZones (filePath) {
  const buf = await fs.readFile(filePath)
  const r = parseConfig(buf.toString())
  const s = new Map()
  r.zone.map(z => s.set(z.name.toLowerCase(), z.file))
  return s
}

export function parseConfig (str) {

  const re = {
    open    : /^\s*([\w\t -]+?)\s*{\s*$/,  // logging, options, etc.
    openzone: /^\s*zone\s*"([^"]+)"\s*(in|IN)?{/,
    close   : /^\s*(};)\s*$/,
    key_val : /^[ \t]+([^\s]+?)\s+([^\r\n]+?)\s*(\/\/[^\r\n]+)?$/,
    keyOnly : /^[ \t]+([^\s]+?)\s*;$/,
    blank   : /^\s*?$/,
    comment : /^\s*(?:\/\/)[^\r\n]*?$/,
  }

  const res = {}
  const statement = []
  let inner = {}

  for (const line of str.split(/[\r\n]/)) {
    if (re.blank.test(line)) continue
    if (re.comment.test(line)) continue

    const open = line.match(re.open)
    if (open) {
      statement.push(open[1])
      continue
    }

    const openzone = line.match(re.openzone)
    if (openzone) {
      statement.push('zone')
      inner.name = openzone[1]
      continue
    }

    const close = line.match(re.close)
    if (close) {
      const statementName = statement.pop()

      if (statementName === 'zone') {
        if (res.zone === undefined) res.zone = []
        res.zone.push(inner)
        inner = {}
      }
      else {
        let target = res
        for (const s of statement) {
          if (target[s] === undefined) target[s] = {}
          target = target[s]
        }
        if (Object.keys(inner).length) {
          target[statementName] = inner
        }
      }

      inner = {}
      continue
    }

    const kv = line.match(re.key_val)
    const ko = line.match(re.keyOnly)

    if (kv) {
      inner[kv[1]] = valueCleanup(kv[2].slice(0,-1))
    }
    else if (ko) {
      inner[ko[1]] = ''
    }
    else {
      console.error(line)
      throw 'parser failed'
    }
  }

  return res
}



/*
const os = require('os')
const nearley = require('nearley')
exports.parseConfig = async str => {
  const grammar = nearley.Grammar.fromCompiled(require('../dist/bind.js'))
  grammar.start = 'main'
  const parser = new nearley.Parser(grammar)
  parser.feed(str)
  if (!str.endsWith(os.EOL)) parser.feed(os.EOL)
  if (parser.length > 1) console.error(`ERROR: ambigious parser rule`)
  if (parser.results.length === 0) return []
  return parser.results[0]
    .filter(z => z[0] && z[0].type) // weed out nulls
    .map(z => z[0])   // remove array nesting
}
*/
