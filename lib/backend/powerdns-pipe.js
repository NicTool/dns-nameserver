import readline from 'node:readline'

import mysql from 'mysql2/promise'

import { getMap, unApplyMap } from '@nictool/dns-resource-record'

import { powerdnsRdata } from '../powerdns-rdata.js'
import Backend from './base.js'

/**
 * PowerdnsPipeBackend — PowerDNS pipe/co-process backend, protocol v1.
 *
 * A drop-in replacement for nt_powerdns.pl. PowerDNS forks it and talks over
 * stdin/stdout in tab-delimited lines:
 *
 *   IN:  HELO\t<version>
 *   OUT: OK\t<banner>
 *
 *   IN:  Q\t<qname>\t<qclass>\t<qtype>\t<id>\t<remote-ip>
 *   OUT: DATA\t<qname>\t<qclass>\t<type>\t<ttl>\t<zone-id>\t<rdata...>
 *        END
 *
 *   IN:  AXFR\t<zone-id>
 *   OUT: DATA\t...   (every record in the zone)
 *        END
 *
 *   IN:  PING
 *   OUT: END
 *
 * This is the pull half of the PowerDNS integration; PowerdnsDbPublisher is
 * the push half, writing rows into a gmysql schema. Both encode rdata through
 * powerdnsRdata, so the two models cannot drift apart.
 */
export class PowerdnsPipeBackend extends Backend {
  constructor(opts = {}) {
    super(opts)

    this.nameserverId = Number(opts.nameserverId ?? 1)
    this.cacheTtl = Number(opts.cacheTtl ?? 20)
    this.verbose = Boolean(opts.verbose)
    this.banner = opts.banner ?? 'NicTool PowerDNS backend ready'

    // Spreading opts.db directly would let an absent environment variable
    // overwrite a default with undefined.
    this.db = {
      host: '127.0.0.1',
      port: 3306,
      user: 'nictool',
      database: 'nictool',
      ssl: { rejectUnauthorized: false },
      ...defined(opts.db),
    }

    this.dbh = null
    this.cache = new Map()
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async connect() {
    if (!this.dbh) {
      this.dbh = await mysql.createConnection(this.db)
      this.log(`MySQL connected (id ${this.dbh.connection.connectionId})`)
    }
    return this.dbh
  }

  async disconnect() {
    const dbh = this.dbh
    this.dbh = null
    if (dbh) await dbh.end()
  }

  async query(sql, params = []) {
    await this.connect()
    try {
      const [rows] = await this.dbh.execute(sql, params)
      return rows
    } catch (err) {
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        this.dbh = null
        await this.connect()
        const [rows] = await this.dbh.execute(sql, params)
        return rows
      }
      throw err
    }
  }

  // ── cache ────────────────────────────────────────────────────────────────

  cacheGet(key) {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expire < Date.now() / 1000) {
      this.cache.delete(key)
      return null
    }
    return entry.data
  }

  cacheSet(key, data) {
    this.cache.set(key, { data, expire: Date.now() / 1000 + this.cacheTtl })
  }

  // ── rdata ────────────────────────────────────────────────────────────────

  /**
   * Pipe protocol v1 carries the priority of MX/SRV as its own field, exactly
   * as the gmysql backend carries it in its own column — so the split is
   * shared with PowerdnsDbPublisher.
   *
   * Rows come straight from the NicTool schema, so the overloaded columns are
   * translated to RFC field names first; that is also what makes every type
   * the resource-record library knows answerable, not just the common few.
   */
  rrContentFields(row, owner) {
    const rec = { ...row }
    unApplyMap(rec, getMap(rec.type))
    for (const f of ['weight', 'priority', 'other', 'description']) {
      if (rec[f] === null || rec[f] === undefined || rec[f] === '') delete rec[f]
    }

    // PowerDNS sends qnames without the root dot; the RR classes require it.
    const fqdn = /\.$/.test(owner) ? owner : `${owner}.`
    // quoted:false — PowerDNS quotes character-strings itself on this path.
    const { content, prio } = powerdnsRdata(rec, fqdn, Number(row.ttl) || 0, {
      quoted: false,
    })
    return prio === null ? [content] : [prio, content]
  }

  // ── queries ──────────────────────────────────────────────────────────────

  async getRecords(qname, qclass, qtype) {
    const cacheKey = `${qname}:${qtype}`
    const cached = this.cacheGet(cacheKey)
    if (cached) {
      this.log(`cache hit ${cacheKey}`)
      return cached
    }

    // Peel labels off the front of qname to find the containing zone.
    const labels = qname.replace(/\.$/, '').split('.')
    const order = []
    const fqdn = labels.join('.') + '.'

    for (let n = 0; n < labels.length; n++) {
      const zoneName = labels.slice(n).join('.')
      // NicTool stores a record's name either fully qualified or relative to
      // its zone — both conventions are in live data — so try both at every
      // depth. `labels.slice(0, n)` is the relative name: for
      // _sip._tcp.example.com under example.com that is "_sip._tcp".
      order.push({ zone: zoneName, record: fqdn })
      const relative = labels.slice(0, n).join('.')
      order.push({ zone: zoneName, record: relative || '@' })
      if (n > 0) order.push({ zone: zoneName, record: `*.${zoneName}.` })
    }

    const wantedZones = [...new Set(order.map((e) => e.zone))]
    if (!wantedZones.length) return []

    const placeholders = wantedZones.map(() => '?').join(',')
    const zoneRows = await this.query(
      `SELECT z.nt_zone_id, z.zone
         FROM nt_zone z
         INNER JOIN nt_zone_nameserver ns ON ns.nt_zone_id = z.nt_zone_id
           AND ns.nt_nameserver_id = ?
        WHERE z.deleted = 0
          AND z.zone IN (${placeholders})`,
      [this.nameserverId, ...wantedZones],
    )

    const zoneIdFor = {}
    for (const z of zoneRows) zoneIdFor[z.zone] = z.nt_zone_id

    const pairs = []
    for (const e of order) {
      const zid = zoneIdFor[e.zone]
      if (zid !== undefined) pairs.push([zid, e.record])
    }
    if (!pairs.length) return []

    const pairPh = pairs.map(() => '(?,?)').join(',')
    const pairParams = pairs.flat()

    let typeClause = ''
    const extraParams = []
    if (qtype !== 'ANY') {
      typeClause = " AND (t.name = ? OR t.name = 'CNAME')"
      extraParams.push(qtype)
    }

    const rows = await this.query(
      `SELECT r.nt_zone_id, t.name AS type,
              r.name, r.ttl, r.address, r.weight, r.priority, r.other,
              r.nt_zone_record_id
         FROM nt_zone_record r
         INNER JOIN nt_zone z ON z.nt_zone_id = r.nt_zone_id AND z.deleted = 0
         INNER JOIN nt_zone_nameserver ns
                 ON ns.nt_zone_id = z.nt_zone_id AND ns.nt_nameserver_id = ?
         LEFT JOIN resource_record_type t ON r.type_id = t.id
        WHERE (r.nt_zone_id, r.name) IN (${pairPh})
          AND r.deleted = 0${typeClause}`,
      [this.nameserverId, ...pairParams, ...extraParams],
    )

    const seen = new Set()
    const result = []
    for (const r of rows) {
      const content = this.rrContentFields(r, qname)
      const line = ['DATA', qname, qclass, r.type, r.ttl, r.nt_zone_id, ...content]
      const key = line.join('\t')
      if (!seen.has(key)) {
        seen.add(key)
        result.push(line)
      }
    }

    this.cacheSet(cacheKey, result)
    return result
  }

  async getNS(qname, qclass) {
    const rows = await this.query(
      `SELECT z.nt_zone_id, ns.ttl, ns.name, ns.address
         FROM nt_zone z
         INNER JOIN nt_zone_nameserver zns ON z.nt_zone_id = zns.nt_zone_id
         INNER JOIN nt_nameserver ns ON zns.nt_nameserver_id = ns.nt_nameserver_id
        WHERE z.zone = ? AND z.deleted = 0 AND ns.deleted = 0`,
      [qname.replace(/\.$/, '')],
    )

    return rows.map((r) => ['DATA', qname, qclass, 'NS', r.ttl, r.nt_zone_id, r.name])
  }

  async getSOA(qname, qclass) {
    const rows = await this.query(
      `SELECT ns.name, z.*
         FROM nt_zone z
         INNER JOIN nt_zone_nameserver zns ON z.nt_zone_id = zns.nt_zone_id
         INNER JOIN nt_nameserver ns ON zns.nt_nameserver_id = ns.nt_nameserver_id
        WHERE z.zone = ? AND z.deleted = 0 AND ns.deleted = 0
        LIMIT 1`,
      [qname.replace(/\.$/, '')],
    )

    if (!rows.length) return []
    const z = rows[0]
    return [
      [
        'DATA',
        qname,
        qclass,
        'SOA',
        z.ttl,
        z.nt_zone_id,
        z.name,
        z.mailaddr,
        z.serial,
        z.refresh,
        z.retry,
        z.expire,
        z.ttl,
      ],
    ]
  }

  async axfr(zoneId) {
    const rows = await this.query(
      `SELECT z.nt_zone_id, z.zone, t.name AS type,
              r.name, r.ttl, r.address, r.weight, r.priority, r.other
         FROM nt_zone z
         INNER JOIN nt_zone_record r ON z.nt_zone_id = r.nt_zone_id
         LEFT JOIN resource_record_type t ON r.type_id = t.id
        WHERE z.nt_zone_id = ? AND z.deleted = 0 AND r.deleted = 0`,
      [zoneId],
    )

    return rows.map((r) => {
      const fqdn = /\.$/.test(r.name) ? r.name : `${r.name}.${r.zone}`
      const content = this.rrContentFields(r, fqdn)
      return ['DATA', fqdn, 'IN', r.type, r.ttl, r.nt_zone_id, ...content]
    })
  }

  /**
   * SOA and NS are answered from the zone and nameserver tables rather than
   * from records, because NicTool keeps them there; ANY has to merge both.
   */
  async lookup({ qname, qclass, qtype }) {
    if (qtype === 'SOA') {
      const rows = await this.getSOA(qname, qclass)
      this.cacheSet(`${qname}:${qtype}`, rows)
      return rows
    }

    if (qtype === 'NS') {
      const rows = uniqRows([
        ...(await this.getNS(qname, qclass)),
        ...(await this.getRecords(qname, qclass, qtype)),
      ])
      this.cacheSet(`${qname}:${qtype}`, rows)
      return rows
    }

    if (qtype === 'ANY') {
      const rows = uniqRows([
        ...(await this.getRecords(qname, qclass, qtype)),
        ...(await this.getNS(qname, qclass)),
      ])
      this.cacheSet(`${qname}:${qtype}`, rows)
      return rows
    }

    return this.getRecords(qname, qclass, qtype)
  }

  // ── protocol ─────────────────────────────────────────────────────────────

  log(msg) {
    if (this.verbose) this.stderr(msg)
  }

  stderr(msg) {
    process.stderr.write(`[nt-powerdns] ${msg}\n`)
  }

  /**
   * Serve until `input` ends.
   *
   * @param {object} [io]
   * @param {stream.Readable} [io.input=process.stdin]
   * @param {stream.Writable} [io.output=process.stdout]
   */
  async run({ input = process.stdin, output = process.stdout } = {}) {
    const write = (line) => output.write(line + '\n')
    const rl = readline.createInterface({ input, crlfDelay: Infinity })

    // The handshake must be the first line PowerDNS sends.
    let heloReceived = false

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue

      if (!heloReceived) {
        if (/^HELO\t\d+$/.test(trimmed)) {
          heloReceived = true
          write(`OK\t${this.banner}`)
          this.log(`HELO received — nameserverId=${this.nameserverId}`)
        } else {
          write('FAIL')
          this.stderr(`Expected HELO, got: ${trimmed}`)
          rl.close()
          return false
        }
        continue
      }

      const parts = trimmed.split('\t')
      const type = parts[0]

      this.log(`received: ${trimmed}`)

      try {
        if (type === 'Q') {
          const [, qname, qclass, qtype] = parts
          for (const r of await this.lookup({ qname, qclass, qtype })) {
            write(r.join('\t'))
          }
        } else if (type === 'AXFR') {
          for (const r of await this.axfr(parts[1])) write(r.join('\t'))
        } else if (type === 'PING') {
          // no-op
        } else {
          this.stderr(`Unknown request type: ${type}`)
        }
      } catch (err) {
        this.stderr(`Error handling ${type}: ${err.message}`)
        write(`LOG\tError: ${err.message}`)
      }

      write('END')
    }

    return true
  }
}

/** The set fields of an object, so a default is not clobbered by undefined. */
function defined(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

function uniqRows(rows) {
  const seen = new Set()
  return rows.filter((r) => {
    const k = r.join('\t')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export default PowerdnsPipeBackend
