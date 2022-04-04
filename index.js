
const os = require('os')

const nearley = require('nearley')

exports.parseBindConfig = async str => {

  const grammar = nearley.Grammar.fromCompiled(require('./dist/bind.js'))
  grammar.start = 'main'

  const parser = new nearley.Parser(grammar)
  parser.feed(str)
  if (!str.endsWith(os.EOL)) parser.feed(os.EOL)

  if (parser.length > 1) {
    console.error(`ERROR: ambigious parser rule`)
  }

  if (parser.results.length === 0) return []

  return parser.results[0]
    .filter(z => z[0] && z[0].type) // weed out nulls
    .map(z => z[0])   // remove array nesting
}
