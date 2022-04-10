





export function valueCleanup (str) {

  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.substr(1,str.length -2) // strip double quotes
  }

  if (/^[0-9.]+$/.test(str) && Number(str).toString() === str) {
    return Number(str)
  }

  return str
}

