
import { valueCleanup } from '../index.js'


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


/*
const os = require('os')
const nearley = require('nearley')
const ns = require('../index')
exports.parseConfig = async str => {
  const grammar = nearley.Grammar.fromCompiled(require('../dist/nsd.js'))
  grammar.start = 'main'
  const parser = new nearley.Parser(grammar)
  parser.feed(str + os.EOL)
  if (!str.endsWith(os.EOL)) parser.feed(os.EOL)
  if (parser.results.length === 0) return []
  const r = {}
  const sections = [ 'key', 'pattern', 'remote-control', 'server', 'tls-auth', 'zone' ]
  parser.results[0]
    .filter(z => z !== null)
    .map(z => { for (const s of sections) {
      if (z[s]) { if (!r[s]) r[s] = []; r[s].push(z[s]) }
    }})

  return r
}
*/
