// PowerdnsDbPublisher against the real PowerDNS 4.x gmysql schema.
//
// The tables are created and dropped by this test, so it needs no PowerDNS
// install — the contract under test is the rows PowerDNS would read. Skips
// when MySQL is unreachable.
import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach } from 'node:test'

import mysql from 'mysql2/promise'

import PowerdnsDbPublisher from '../lib/publisher/powerdns-db.js'

const DSN =
  process.env.NICTOOL_TEST_DSN ?? 'mysql://nictool:lootcin!mysql@127.0.0.1:3306/nictool'

// Verbatim from the PowerDNS 4.x gmysql schema, trimmed to what a publisher writes.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS domains (
     id              INT AUTO_INCREMENT,
     name            VARCHAR(255) NOT NULL,
     master          VARCHAR(128) DEFAULT NULL,
     last_check      INT DEFAULT NULL,
     type            VARCHAR(8) NOT NULL,
     notified_serial INT UNSIGNED DEFAULT NULL,
     account         VARCHAR(40) DEFAULT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY name_index (name)
   ) Engine=InnoDB CHARACTER SET 'latin1'`,
  `CREATE TABLE IF NOT EXISTS records (
     id        BIGINT AUTO_INCREMENT,
     domain_id INT DEFAULT NULL,
     name      VARCHAR(255) DEFAULT NULL,
     type      VARCHAR(10) DEFAULT NULL,
     content   VARCHAR(64000) DEFAULT NULL,
     ttl       INT DEFAULT NULL,
     prio      INT DEFAULT NULL,
     disabled  TINYINT(1) DEFAULT 0,
     ordername VARCHAR(255) BINARY DEFAULT NULL,
     auth      TINYINT(1) DEFAULT 1,
     PRIMARY KEY (id),
     KEY nametype_index (name, type)
   ) Engine=InnoDB CHARACTER SET 'latin1'`,
]

let conn = null
let skip = false
let publisher = null

const zoneMap = (records, zone = {}) =>
  new Map([
    [
      'pdns.test',
      {
        zone: {
          zone: 'pdns.test',
          ttl: 300,
          serial: 7,
          mailaddr: 'hostmaster.pdns.test.',
          refresh: 7200,
          retry: 3600,
          expire: 1209600,
          minimum: 3600,
          ...zone,
        },
        records,
      },
    ],
  ])

before(async () => {
  try {
    const u = new URL(DSN)
    conn = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      connectTimeout: 4000,
    })
  } catch (err) {
    skip = `MySQL unreachable: ${err.code ?? err.message}`
    return
  }

  for (const ddl of SCHEMA) await conn.query(ddl)
  publisher = new PowerdnsDbPublisher({ dsn: DSN })
})

after(async () => {
  await publisher?.disconnect()
  if (conn) {
    await conn.query('DROP TABLE IF EXISTS records')
    await conn.query('DROP TABLE IF EXISTS domains')
    await conn.end()
  }
})

beforeEach(async () => {
  if (skip) return
  await conn.query('DELETE FROM records')
  await conn.query('DELETE FROM domains')
})

const rowsFor = async (type) =>
  (await conn.query('SELECT * FROM records WHERE type = ? ORDER BY name', [type]))[0]

describe('PowerdnsDbPublisher', () => {
  it('creates the domain and reports what it wrote', async (t) => {
    if (skip) return t.skip(skip)

    const artifacts = await publisher.publish(
      zoneMap([{ owner: 'www', type: 'A', address: '192.0.2.1', ttl: 300 }]),
    )

    assert.equal(artifacts.kind, 'powerdns-db')
    assert.equal(artifacts.zoneCount, 1)
    assert.equal(artifacts.recordCount, 2, 'the A record plus a synthesized SOA')

    const [domains] = await conn.query('SELECT * FROM domains')
    assert.equal(domains.length, 1)
    assert.equal(domains[0].name, 'pdns.test')
    assert.equal(domains[0].type, 'NATIVE')
    assert.equal(domains[0].notified_serial, 7)
  })

  it('synthesizes the SOA at the apex, since NicTool has no SOA record', async (t) => {
    if (skip) return t.skip(skip)

    // mailaddr is the RNAME; the MNAME is taken from the zone's apex NS record.
    await publisher.publish(
      zoneMap([{ owner: '@', type: 'NS', dname: 'ns1.pdns.test.' }]),
    )
    const [soa] = await rowsFor('SOA')

    assert.equal(soa.name, 'pdns.test')
    assert.equal(
      soa.content,
      'ns1.pdns.test hostmaster.pdns.test 7 7200 3600 1209600 3600',
    )
    assert.equal(soa.prio, null)
  })

  it('qualifies record owners against the apex', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(
      zoneMap([
        { owner: 'www', type: 'A', address: '192.0.2.1' },
        { owner: '@', type: 'A', address: '192.0.2.2' },
        { owner: 'deep.sub', type: 'A', address: '192.0.2.3' },
      ]),
    )

    assert.deepEqual(
      (await rowsFor('A')).map((r) => r.name),
      ['deep.sub.pdns.test', 'pdns.test', 'www.pdns.test'],
    )
  })

  it('writes MX priority to the prio column, not the content', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(
      zoneMap([{ owner: '@', type: 'MX', exchange: 'mail.pdns.test.', preference: 10 }]),
    )

    const [mx] = await rowsFor('MX')
    assert.equal(mx.content, 'mail.pdns.test', 'no priority inside the rdata')
    assert.equal(mx.prio, 10)
  })

  it('writes SRV as "weight port target" with its own prio', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(
      zoneMap([
        {
          owner: '_sip._tcp',
          type: 'SRV',
          target: 'sip.pdns.test.',
          priority: 20,
          weight: 10,
          port: 5060,
        },
      ]),
    )

    const [srv] = await rowsFor('SRV')
    assert.equal(srv.content, '10 5060 sip.pdns.test')
    assert.equal(srv.prio, 20)
  })

  it('falls back to the zone TTL when a record has none', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(zoneMap([{ owner: 'www', type: 'A', address: '192.0.2.1' }]))

    assert.equal((await rowsFor('A'))[0].ttl, 300)
  })

  it('marks records enabled and authoritative for PowerDNS', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(zoneMap([{ owner: 'www', type: 'A', address: '192.0.2.1' }]))

    const [a] = await rowsFor('A')
    assert.equal(a.disabled, 0)
    assert.equal(a.auth, 1)
  })

  it('skips soft-deleted records', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(
      zoneMap([
        { owner: 'live', type: 'A', address: '192.0.2.1' },
        { owner: 'gone', type: 'A', address: '192.0.2.2', deleted: true },
      ]),
    )

    assert.deepEqual(
      (await rowsFor('A')).map((r) => r.name),
      ['live.pdns.test'],
    )
  })

  it('replaces a zone on republish rather than accumulating', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(zoneMap([{ owner: 'old', type: 'A', address: '192.0.2.1' }]))
    await publisher.publish(
      zoneMap([{ owner: 'new', type: 'A', address: '192.0.2.9' }], { serial: 8 }),
    )

    assert.deepEqual(
      (await rowsFor('A')).map((r) => r.name),
      ['new.pdns.test'],
    )

    const [domains] = await conn.query('SELECT * FROM domains')
    assert.equal(domains.length, 1, 'the domain is reused, not duplicated')
    assert.equal(domains[0].notified_serial, 8)
  })

  it('leaves the previous zone intact when a publish fails', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(zoneMap([{ owner: 'good', type: 'A', address: '192.0.2.1' }]))

    // content is VARCHAR(64000); a value past the row limit aborts the INSERT.
    await assert.rejects(() =>
      publisher.publish(
        zoneMap([{ owner: 'bad', type: 'TXT', data: 'x'.repeat(70000) }]),
      ),
    )

    assert.deepEqual(
      (await rowsFor('A')).map((r) => r.name),
      ['good.pdns.test'],
      'the transaction rolled back to the previous contents',
    )
  })

  it('keeps a bad record from costing the whole zone', async (t) => {
    if (skip) return t.skip(skip)

    // The file publishers comment such a record out and publish the rest; with
    // no file to comment, it is reported on the artifacts instead.
    const artifacts = await publisher.publish(
      zoneMap([
        { owner: 'good', type: 'A', address: '192.0.2.1', ttl: 300 },
        { owner: 'bad', type: 'NOSUCHTYPE', address: 'x' },
      ]),
    )

    assert.equal(artifacts.recordCount, 2, 'the SOA and the good record')
    assert.deepEqual(
      artifacts.skipped.map((e) => [e.owner, e.type]),
      [['bad.pdns.test', 'NOSUCHTYPE']],
    )
    assert.match(artifacts.skipped[0].message, /unsupported record type/)

    const rows = await rowsFor('A')
    assert.equal(rows.length, 1, 'the good record still reached PowerDNS')
  })

  it('publishes a serial of 0 rather than replacing it with 1', async (t) => {
    if (skip) return t.skip(skip)

    await publisher.publish(
      zoneMap([{ owner: 'www', type: 'A', address: '192.0.2.1' }], { serial: 0 }),
    )

    const [domains] = await conn.query('SELECT notified_serial FROM domains')
    assert.equal(domains[0].notified_serial, 0)
  })
})
