import dns from 'node:dns/promises'

import path from 'path'

export { default as Nameserver } from './lib/base.js'
export { default as PublishMetrics, STAGES, countZones } from './lib/metrics.js'
export { default as NativeNS } from './lib/native.js'
export {
  default as FileEngine,
  BindNS,
  KnotNS,
  NsdNS,
  PowerdnsNS,
  CorednsNS,
  DjbdnsNS,
  TinydnsNS,
  MaradnsNS,
} from './lib/file-engine.js'

export { default as Source } from './lib/source/base.js'
export { default as FileSource } from './lib/source/file.js'
export { default as MysqlSource } from './lib/source/mysql.js'

export { default as Publisher } from './lib/publisher/base.js'
export { default as MemoryPublisher } from './lib/publisher/memory.js'
export { default as Rfc1035Publisher } from './lib/publisher/rfc1035.js'
export { default as TinydnsCdbPublisher } from './lib/publisher/tinydns-cdb.js'
export { default as PowerdnsDbPublisher } from './lib/publisher/powerdns-db.js'
export { default as MaradnsPublisher } from './lib/publisher/maradns.js'
export { default as NonePublisher } from './lib/publisher/none.js'
export { default as CorednsRedisPublisher } from './lib/publisher/coredns-redis.js'

export {
  toBindConfig,
  toCorefileConfig,
  toKnotConfig,
  toMaradnsConfig,
  toNsdConfig,
  toNameserverConfig,
} from './lib/config.js'

export { corednsRedisRdata, corednsRedisSoa, COREDNS_TYPES } from './lib/coredns-rdata.js'
export { toResource, soaResource, encodable, wireTypeName } from './lib/wire.js'
export { default as RespClient, encodeCommand, parseReply } from './lib/resp.js'

export { default as Backend } from './lib/backend/base.js'
export { default as PowerdnsPipeBackend } from './lib/backend/powerdns-pipe.js'

export { default as AxfrServer } from './lib/axfr-server.js'

export { default as Transport } from './lib/transport/base.js'
export { default as NoopTransport } from './lib/transport/noop.js'
export { default as PullTransport } from './lib/transport/pull.js'
export { default as RsyncTransport } from './lib/transport/rsync.js'
export { default as AxfrTransport } from './lib/transport/axfr.js'
export { default as DbReplicationTransport } from './lib/transport/db-replication.js'

export {
  DNSSEC_STRATEGY,
  ALGORITHMS,
  DEFAULT_ALGORITHM,
  strategyFor,
  ensureKeys,
  signZoneFile,
} from './lib/dnssec.js'

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
