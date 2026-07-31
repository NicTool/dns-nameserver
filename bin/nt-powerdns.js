#!/usr/bin/env node
/**
 * nt-powerdns — run PowerdnsPipeBackend as the process PowerDNS forks.
 *
 * Configured entirely from the environment, because PowerDNS gives a
 * pipe-command no arguments of its own:
 *
 *   NT_PDNS_DB_HOST    (default: 127.0.0.1)
 *   NT_PDNS_DB_PORT    (default: 3306)
 *   NT_PDNS_DB_USER    (default: nictool)
 *   NT_PDNS_DB_PASS    (required)
 *   NT_PDNS_DB_NAME    (default: nictool)
 *   NT_PDNS_NS_ID      nameserver id to serve (default: 1)
 *   NT_PDNS_LOG        set to 1 for verbose stderr logging
 *   NT_PDNS_CACHE_TTL  seconds to cache query results (default: 20)
 */
import PowerdnsPipeBackend from '../lib/backend/powerdns-pipe.js'

if (!process.env.NT_PDNS_DB_PASS) {
  process.stdout.write('FAIL\n')
  process.stderr.write('[nt-powerdns] NT_PDNS_DB_PASS is required\n')
  process.exit(1)
}

const backend = new PowerdnsPipeBackend({
  nameserverId: process.env.NT_PDNS_NS_ID,
  cacheTtl: process.env.NT_PDNS_CACHE_TTL,
  verbose: process.env.NT_PDNS_LOG === '1',
  db: {
    host: process.env.NT_PDNS_DB_HOST,
    port: process.env.NT_PDNS_DB_PORT ? Number(process.env.NT_PDNS_DB_PORT) : undefined,
    user: process.env.NT_PDNS_DB_USER,
    password: process.env.NT_PDNS_DB_PASS,
    database: process.env.NT_PDNS_DB_NAME,
  },
})

const ok = await backend.run()
await backend.disconnect()
if (!ok) process.exit(1)
