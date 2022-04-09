













exports.valueCleanup = function (str) {
  // strip double quotes
  if (str.charAt(0) === '"' && str.charAt(str.length -1) === '"') {
    str = str.substr(1,str.length -2)
  }

  if (/^[0-9.]+$/.test(str) && Number(str).toString() === str) {
    return Number(str)
  }

  return str
}
