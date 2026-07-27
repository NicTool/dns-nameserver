// MysqlSource against a real NicTool schema.
//
// Creates its own zone/records, asserts the shape the engines consume, then
// removes them. Skips when MySQL is unreachable.
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import mysql from 'mysql2/promise'

import MysqlSource from '../lib/source/mysql.js'

const DSN =
  process.env.NICTOOL_TEST_DSN ?? 'mysql://nictool:lootcin!mysql@127.0.0.1:3306/nictool'

const ZONE_ID = 990001
const NS_ID = 9901 // nt_nameserver_id is SMALLINT UNSIGNED
const GROUP_ID = 1

let conn = null
let skip = false
let source = null

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

  await cleanup()
  await conn.query(
    `INSERT INTO nt_zone (nt_zone_id, nt_group_id, zone, mailaddr, serial, refresh, retry,
                          expire, minimum, ttl, deleted)
     VALUES (?, ?, 'mysqlsource.test', 'ns1.mysqlsource.test.', 42, 7200, 3600, 1209600, 3600, 300, 0)`,
    [ZONE_ID, GROUP_ID],
  )

  const [[a]] = await conn.query("SELECT id FROM resource_record_type WHERE name='A'")
  const [[srv]] = await conn.query("SELECT id FROM resource_record_type WHERE name='SRV'")

  await conn.query(
    `INSERT INTO nt_zone_record (nt_zone_id, name, ttl, type_id, address, weight, priority, other, deleted)
     VALUES (?, 'www', 300, ?, '192.0.2.55', NULL, NULL, NULL, 0),
            (?, 'gone', 300, ?, '192.0.2.56', NULL, NULL, NULL, 1),
            (?, '_sip._tcp', 300, ?, 'sip.mysqlsource.test.', 10, 20, '5060', 0)`,
    [ZONE_ID, a.id, ZONE_ID, a.id, ZONE_ID, srv.id],
  )

  source = new MysqlSource({ dsn: DSN })
})

after(async () => {
  await source?.disconnect()
  if (conn) {
    await cleanup()
    await conn.end()
  }
})

async function cleanup() {
  await conn.query('DELETE FROM nt_zone_record WHERE nt_zone_id = ?', [ZONE_ID])
  await conn.query('DELETE FROM nt_zone_nameserver WHERE nt_zone_id = ?', [ZONE_ID])
  await conn.query('DELETE FROM nt_zone WHERE nt_zone_id = ?', [ZONE_ID])
}

describe('MysqlSource', () => {
  it('keys zones by canonical name', async (t) => {
    if (skip) return t.skip(skip)

    const zones = await source.getZones({})

    assert.ok(zones.has('mysqlsource.test'))
    assert.equal(zones.get('mysqlsource.test').zone.zone, 'mysqlsource.test')
  })

  it('returns SOA fields the engines need', async (t) => {
    if (skip) return t.skip(skip)

    const { zone } = (await source.getZones({})).get('mysqlsource.test')

    assert.equal(zone.serial, 42)
    assert.equal(zone.refresh, 7200)
    assert.equal(zone.retry, 3600)
    assert.equal(zone.expire, 1209600)
    assert.equal(zone.minimum, 3600)
    assert.equal(zone.mailaddr, 'ns1.mysqlsource.test.')
  })

  it('names the record owner and resolves its type', async (t) => {
    if (skip) return t.skip(skip)

    const { records } = (await source.getZones({})).get('mysqlsource.test')
    const www = records.find((r) => r.owner === 'www')

    assert.ok(www, 'owner is the field the engines read')
    assert.equal(www.type, 'A', 'type_id resolved via resource_record_type')
    assert.equal(www.address, '192.0.2.55', 'A keeps `address` in both shapes')
  })

  it('omits soft-deleted records', async (t) => {
    if (skip) return t.skip(skip)

    const { records } = (await source.getZones({})).get('mysqlsource.test')

    assert.equal(
      records.find((r) => r.owner === 'gone'),
      undefined,
    )
  })

  it('translates NicTool columns to the RFC field names', async (t) => {
    if (skip) return t.skip(skip)

    const { records } = (await source.getZones({})).get('mysqlsource.test')
    const srv = records.find((r) => r.type === 'SRV')

    // The file stores hold records this way, so both Sources agree and the
    // record can be handed straight to a resource-record class.
    assert.equal(srv.target, 'sip.mysqlsource.test.', 'address -> target')
    assert.equal(srv.port, 5060, 'other -> port, as a number')
    assert.equal(srv.address, undefined, 'the raw column is not left behind')
    assert.equal(srv.other, undefined)
    assert.equal(srv.weight, 10)
    assert.equal(srv.priority, 20)
  })

  it('restricts to the zones assigned to a nameserver', async (t) => {
    if (skip) return t.skip(skip)

    assert.equal((await source.getZones({ nameserverId: NS_ID })).size, 0)

    await conn.query(
      'INSERT INTO nt_zone_nameserver (nt_zone_id, nt_nameserver_id) VALUES (?, ?)',
      [ZONE_ID, NS_ID],
    )

    const assigned = await source.getZones({ nameserverId: NS_ID })
    assert.equal(assigned.size, 1)
    assert.ok(assigned.has('mysqlsource.test'))
  })

  it('accepts discrete connection options as well as a DSN', async (t) => {
    if (skip) return t.skip(skip)

    const u = new URL(DSN)
    const src = new MysqlSource({
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
    })

    try {
      assert.ok((await src.getZones({})).has('mysqlsource.test'))
    } finally {
      await src.disconnect()
    }
  })
})
