
import fs from 'fs/promises'

export default {
  getZones,
  getZone,
}

export async function getZones (filePath) {
  const buf = await fs.readFile(filePath)
  const s = new Map()
  buf.toString()
    .split(/[\r\n]/)  // split on newlines
    .filter(z => /^[Z|.]/.test(z))  // records that start with Z or .
    .map(z => {
      const zoneName = (z.match(/^(?:Z|\.)([^:]+?)(?:\.)?:/))[1].toLowerCase()
      s.set(zoneName, 'data')
    })

  return s
}

export async function getZone (filePath, zone) {
  const buf = await fs.readFile(filePath)
  return buf.toString()
    .split(/[\r\n]/)
    .filter(z => {
      let owner = z.substr(1).split(':')[0].toLowerCase()
      if (owner.endsWith('.')) owner = owner.slice(0, -1)
      if (owner === zone) return true
      return owner.endsWith(`.${zone}`)
    })
}