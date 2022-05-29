
import dns from 'dns/promises'

import path from 'path'

export function fullPath (basePath, filePath) {
  if (!basePath) return filePath
  // if (filePath.startsWith('/')) return filePath
  return path.resolve(basePath, path.basename(filePath))
}

export function valueCleanup (str) {

  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.substr(1,str.length -2) // strip double quotes
  }

  if (/^[0-9.]+$/.test(str) && Number(str).toString() === str) {
    return Number(str)
  }

  return str
}

export async function isDelegated (zone, expectedNS) {
  try {
    const servers = await dns.resolveNs(zone)
    if (!servers) return false
    for (const s of servers) {
      if (expectedNS.includes(s)) return true
    }
    return false
  }
  catch (e) {
    switch (e.code) {
      case 'ENOTFOUND':
      case 'ENODATA':
        return false
      case 'ESERVFAIL':
        return true  // TODO, not sure
      default:
        throw e
    }
  }
}