import mysql from 'mysql2/promise'

import { powerdnsRdata, powerdnsSoa } from '../powerdns-rdata.js'
import { ownerFqdn } from '../zone-name.js'
import Publisher from './base.js'

const num = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback

function parseDsn(dsn) {
  const u = new URL(dsn)
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  }
}

/**
 * PowerdnsDbPublisher – writes zones into a PowerDNS gmysql backend.
 *
 * This is the push model: NicTool owns the data and copies it into PowerDNS's
 * own `domains`/`records` tables, which PowerDNS serves without knowing NicTool
 * exists. The alternative is the pull model — `nt-powerdns`, the pipe backend,
 * which leaves the data in NicTool and answers PowerDNS live. Pick one; they
 * share the rdata mapping but not the deployment.
 *
 * Each zone is replaced inside a transaction, so a failure part-way leaves
 * PowerDNS serving the previous contents rather than a half-written zone.
 */
export class PowerdnsDbPublisher extends Publisher {
  constructor(opts = {}) {
    super(opts)
    const { dsn, host, port, user, password, database } = opts
    this.connConfig = dsn
      ? parseDsn(dsn)
      : { host, port: port ?? 3306, user, password, database }
    // NATIVE: PowerDNS serves the zone without AXFR replication, which is what
    // NicTool-as-source-of-truth wants.
    this.domainType = opts.domainType ?? 'NATIVE'
    this.pool = null
  }

  async connect() {
    if (!this.pool) {
      this.pool = mysql.createPool({
        ...this.connConfig,
        waitForConnections: true,
        connectionLimit: 4,
      })
    }
    return this.pool
  }

  async disconnect() {
    const pool = this.pool
    this.pool = null
    await pool?.end()
  }

  async publish(zones) {
    const pool = await this.connect()
    let recordCount = 0
    const skipped = []

    for (const [apex, { zone, records }] of zones) {
      recordCount += await this._publishZone(pool, apex, zone, records, skipped)
    }

    const artifacts = { kind: 'powerdns-db', zoneCount: zones.size, recordCount, skipped }
    this.emit('published', artifacts)
    return artifacts
  }

  async _publishZone(pool, apex, zone, records, skipped = []) {
    const rows = this._rowsFor(apex, zone, records, skipped)
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      const [found] = await conn.query('SELECT id FROM domains WHERE name = ?', [apex])
      let domainId = found[0]?.id
      if (domainId === undefined) {
        const [res] = await conn.query('INSERT INTO domains (name, type) VALUES (?, ?)', [
          apex,
          this.domainType,
        ])
        domainId = res.insertId
      }

      await conn.query('DELETE FROM records WHERE domain_id = ?', [domainId])
      if (rows.length) {
        await conn.query(
          'INSERT INTO records (domain_id, name, type, content, ttl, prio, disabled, auth) VALUES ?',
          [rows.map((r) => [domainId, r.name, r.type, r.content, r.ttl, r.prio, 0, 1])],
        )
      }

      await conn.query('UPDATE domains SET notified_serial = ? WHERE id = ?', [
        num(zone?.serial, 1),
        domainId,
      ])

      await conn.commit()
      return rows.length
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  }

  /** NicTool has no SOA record — it lives in the zone's columns — so synthesize one. */
  _rowsFor(apex, zone, records, skipped = []) {
    const defaultTtl = num(zone?.ttl, 3600)
    const rows = [
      {
        name: apex,
        type: 'SOA',
        content: powerdnsSoa(zone, apex, records),
        ttl: defaultTtl,
        prio: null,
      },
    ]

    for (const rec of records) {
      if (rec.deleted) continue
      const type = String(rec.type ?? '').toUpperCase()
      if (type === 'SOA') continue

      const owner = ownerFqdn(rec, apex)
      try {
        const { content, prio } = powerdnsRdata(rec)
        rows.push({ name: owner, type, content, ttl: num(rec.ttl, defaultTtl), prio })
      } catch (err) {
        // The file publishers comment a bad record out and keep the zone; there
        // is no file to comment here, so report it on the artifacts instead.
        skipped.push({
          zone: apex,
          owner,
          type,
          message: String(err.message).split('\n')[0],
        })
      }
    }
    return rows
  }
}

export default PowerdnsDbPublisher
