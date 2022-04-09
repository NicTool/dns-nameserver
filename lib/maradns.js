

exports.parseConfig = async str => {
  // https://maradns.samiam.org/tutorial/man.mararc.html

  const blank = /^\s*?$/
  const comment = /^\s*(?:#)[^\r\n]*?$/
  const variable = /^([^ \t]*)\s*=\s*([^\r\n]*)$/

  const r = {}

  for (const line of str.split(/[\r\n]/)) {

    if (blank.test(line)) continue
    if (comment.test(line)) continue

    const match = line.match(variable)
    if (match) {
      r[match[1]] = valueCleanup(match[2])
    }
    else {
      console.log(line)
      throw ('parser failed')
    }
  }

  return r
}

function valueCleanup (str) {
  // strip double quotes
  if (str.charAt(0) === '"' && str.charAt(str.length -1) === '"') {
    str = str.substr(1,str.length -2)
  }

  if (/^[0-9.]+$/.test(str) && Number(str).toString() === str) {
    return Number(str)
  }

  return str
}

