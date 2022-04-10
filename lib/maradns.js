
import { valueCleanup } from '../index.js'


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

