
import fs     from 'fs/promises'

export default {
  getZones,
}

export async function getZones (filePath) {
  const buf = await fs.readFile(filePath)
  const s = new Map()
  buf.toString()
    .split(/[\r\n]/)
    .filter(z => /^Z/.test(z))
    .map(z => s.set((z.match(/^Z([^:]+?):/))[1].toLowerCase(), 'data'))

  return s
}