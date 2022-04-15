
import path from 'path'


export default {
  fullPath,
}

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

