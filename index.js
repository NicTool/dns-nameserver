import dns from 'node:dns/promises'

import path from 'path'

export { default as Nameserver } from './lib/base.js'
export { default as NativeNS } from './lib/native.js'
export {
  default as FileEngine,
  BindNS,
  KnotNS,
  NsdNS,
  PowerdnsNS,
  TinydnsNS,
  MaradnsNS,
} from './lib/file-engine.js'

export { default as Source } from './lib/source/base.js'
export { default as TomlSource } from './lib/source/toml.js'
export { default as MysqlSource } from './lib/source/mysql.js'

export { default as Publisher } from './lib/publisher/base.js'
export { default as MemoryPublisher } from './lib/publisher/memory.js'
export { default as Rfc1035Publisher } from './lib/publisher/rfc1035.js'
export { default as TinydnsCdbPublisher } from './lib/publisher/tinydns-cdb.js'
export { default as PowerdnsDbPublisher } from './lib/publisher/powerdns-db.js'

export { default as Transport } from './lib/transport/base.js'
export { default as NoopTransport } from './lib/transport/noop.js'
export { default as RsyncTransport } from './lib/transport/rsync.js'
export { default as AxfrTransport } from './lib/transport/axfr.js'
export { default as DbReplicationTransport } from './lib/transport/db-replication.js'

export { default as Signer } from './lib/signer/base.js'
export { default as NoneSigner } from './lib/signer/none.js'
export { default as MemorySigner } from './lib/signer/memory.js'
export { default as Rfc1035Signer } from './lib/signer/rfc1035.js'

export function fullPath(basePath, filePath) {
  if (!basePath) return filePath
  // if (filePath.startsWith('/')) return filePath
  return path.resolve(basePath, path.basename(filePath))
}

export function valueCleanup(str) {
  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.substr(1, str.length - 2) // strip double quotes
  }

  if (/^[0-9.]+$/.test(str) && Number(str).toString() === str) {
    return Number(str)
  }

  return str
}

export async function isDelegated(zone, expectedNS) {
  try {
    const servers = await dns.resolveNs(zone)
    if (!servers) return false
    for (const s of servers) {
      if (expectedNS.includes(s)) return true
    }
    return false
  } catch (e) {
    switch (e.code) {
      case 'ENOTFOUND':
      case 'ENODATA':
        return false
      case 'ESERVFAIL':
        return true // TODO, not sure
      default:
        throw e
    }
  }
}
