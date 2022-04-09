
const os = require('os')

const nearley = require('nearley')

exports.parseConfig = async str => {

  // eslint-disable-next-line node/no-unpublished-require
  const grammar = nearley.Grammar.fromCompiled(require('../dist/knot.js'))
  grammar.start = 'main'

  const parser = new nearley.Parser(grammar)
  parser.feed(str)
  if (!str.endsWith(os.EOL)) parser.feed(os.EOL)

  if (parser.results.length === 0) return []

  const r = {}

  const sections = [ 'acl', 'key', 'log', 'policy', 'remote', 'server', 'template', 'zone' ]

  parser.results[0][0]
    .filter(z => z !== null)
    .map(z => {
      for (const s of sections) {
        if (z[s]) {
          if (!r[s]) r[s] = []
          r[s].push(...z[s])
        }
      }
    })

  return r
}