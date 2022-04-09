
const os = require('os')

const nearley = require('nearley')

const ns = require('../index')

exports.parseConfig = async str => {

  // eslint-disable-next-line node/no-unpublished-require
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
    .map(z => {
      for (const s of sections) {
        if (z[s]) {
          if (!r[s]) r[s] = []
          r[s].push(z[s])
        }
      }
    })

  return r
}
