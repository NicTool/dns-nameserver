// Drives bin/nt-powerdns.js the way PowerDNS does: spawn it and speak the
// pipe backend v1 protocol over stdin/stdout.
//
// Guards the rdata mapping it now shares with PowerdnsDbPublisher — pipe v1
// carries MX/SRV priority as its own tab-delimited field, so a regression
// there would silently reshape every answer.
//
// Skips when MySQL is unreachable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'

import mysql from 'mysql2/promise'

const BIN = fileURLToPath(new URL('../bin/nt-powerdns.js', import.meta.url))
const DSN =
  process.env.NICTOOL_TEST_DSN ?? 'mysql://nictool:lootcin!mysql@127.0.0.1:3306/nictool'

const ZONE = 'pipe.test'
const ZID = 993001
const NSID = 9931

let conn = null
let skip = false

/** One request/response exchange, ending at the backend's END line. */
async function ask(lines) {
  const u = new URL(DSN)
  const child = spawn(process.execPath, [BIN], {
    env: {
      ...process.env,
      NT_PDNS_DB_HOST: u.hostname,
      NT_PDNS_DB_PORT: String(Number(u.port) || 3306),
      NT_PDNS_DB_USER: decodeURIComponent(u.username),
      NT_PDNS_DB_PASS: decodeURIComponent(u.password),
      NT_PDNS_DB_NAME: u.pathname.replace(/^\//, ''),
      NT_PDNS_NS_ID: String(NSID),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stdin.write(`HELO\t1\n`)
  for (const l of lines) child.stdin.write(l + '\n')
  child.stdin.end()

  await new Promise((resolve) => child.once('close', resolve))
  return out.split('\n').filter(Boolean)
}

const dataLines = (out) =>
  out.filter((l) => l.startsWith('DATA')).map((l) => l.split('\t'))

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
     VALUES (?, 1, ?, 'ns1.pipe.test.', 21, 7200, 3600, 1209600, 3600, 300, 0)`,
    [ZID, ZONE],
  )
  await conn.query(
    `INSERT INTO nt_nameserver (nt_nameserver_id, nt_group_id, name, ttl, address,
                                export_type_id, deleted)
     VALUES (?, 1, 'ns1.pipe.test.', 86400, '192.0.2.53', 1, 0)`,
    [NSID],
  )
  await conn.query(
    'INSERT INTO nt_zone_nameserver (nt_zone_id, nt_nameserver_id) VALUES (?, ?)',
    [ZID, NSID],
  )

  const typeId = async (name) =>
    (await conn.query('SELECT id FROM resource_record_type WHERE name = ?', [name]))[0][0]
      .id

  await conn.query(
    `INSERT INTO nt_zone_record (nt_zone_id, name, ttl, type_id, address, weight, priority, other, deleted)
     VALUES (?, 'www.pipe.test.', 300, ?, '192.0.2.7', NULL, NULL, NULL, 0),
            (?, 'pipe.test.',     300, ?, 'mail.pipe.test.', 10, NULL, NULL, 0),
            (?, '_sip._tcp.pipe.test.', 300, ?, 'sip.pipe.test.', 10, 20, '5060', 0)`,
    [ZID, await typeId('A'), ZID, await typeId('MX'), ZID, await typeId('SRV')],
  )

  // Names stored relative to the zone, one and two labels deep. Live data holds
  // both these and fully-qualified names.
  await conn.query(
    `INSERT INTO nt_zone_record (nt_zone_id, name, ttl, type_id, address, deleted)
     VALUES (?, 'mail', 300, ?, '192.0.2.25', 0),
            (?, 'default._domainkey', 300, ?, 'v=DKIM1; k=rsa; p=MIIB', 0)`,
    [ZID, await typeId('A'), ZID, await typeId('TXT')],
  )
})

after(async () => {
  if (conn) {
    await cleanup()
    await conn.end()
  }
})

async function cleanup() {
  await conn.query('DELETE FROM nt_zone_record WHERE nt_zone_id = ?', [ZID])
  await conn.query('DELETE FROM nt_zone_nameserver WHERE nt_zone_id = ?', [ZID])
  await conn.query('DELETE FROM nt_zone WHERE nt_zone_id = ?', [ZID])
  await conn.query('DELETE FROM nt_nameserver WHERE nt_nameserver_id = ?', [NSID])
}

describe('nt_powerdns pipe backend', () => {
  it('completes the HELO handshake', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([])
    assert.match(out[0], /^OK\t/)
  })

  it('rejects a first line that is not HELO', async (t) => {
    if (skip) return t.skip(skip)

    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, NT_PDNS_DB_PASS: 'x' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stdin.write('Q\twww.pipe.test\tIN\tA\t-1\t127.0.0.1\n')
    child.stdin.end()
    await new Promise((r) => child.once('close', r))

    assert.match(out, /^FAIL/)
  })

  it('answers an A query and terminates with END', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\twww.${ZONE}\tIN\tA\t-1\t127.0.0.1`])
    const [a] = dataLines(out)

    assert.equal(a[1], `www.${ZONE}`)
    assert.equal(a[3], 'A')
    assert.equal(a[6], '192.0.2.7')
    assert.ok(out.includes('END'))
  })

  it('carries the MX preference as its own protocol field', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\t${ZONE}\tIN\tMX\t-1\t127.0.0.1`])
    const mx = dataLines(out).find((l) => l[3] === 'MX')

    // DATA qname qclass type ttl id <prio> <exchange>
    assert.equal(mx[6], '10', 'priority is a separate field in pipe v1')
    assert.equal(mx[7], `mail.${ZONE}`, 'and is not repeated inside the rdata')
  })

  it('renders SRV as prio then "weight port target"', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\t_sip._tcp.${ZONE}\tIN\tSRV\t-1\t127.0.0.1`])
    const srv = dataLines(out).find((l) => l[3] === 'SRV')

    assert.equal(srv[6], '20')
    assert.equal(srv[7], `10 5060 sip.${ZONE}`)
  })

  it('answers SOA from the zone columns', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\t${ZONE}\tIN\tSOA\t-1\t127.0.0.1`])
    const soa = dataLines(out).find((l) => l[3] === 'SOA')

    assert.equal(soa[1], ZONE)
    assert.equal(soa[8], '21', 'the zone serial')
  })

  it('serves a full AXFR for the zone', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`AXFR\t${ZID}`])
    const types = dataLines(out).map((l) => l[3])

    assert.ok(types.includes('A'))
    assert.ok(types.includes('MX'))
    assert.ok(types.includes('SRV'))
  })

  it('resolves a name stored relative to its zone', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\tmail.${ZONE}\tIN\tA\t-1\t127.0.0.1`])
    const [a] = dataLines(out)

    assert.equal(a[6], '192.0.2.25')
  })

  it('resolves a multi-label relative name such as DKIM', async (t) => {
    if (skip) return t.skip(skip)

    // The candidate builder used to pair the zone with only the first label
    // ("default"), so every _domainkey record fell through unanswered.
    const out = await ask([`Q\tdefault._domainkey.${ZONE}\tIN\tTXT\t-1\t127.0.0.1`])
    const txt = dataLines(out).find((l) => l[3] === 'TXT')

    assert.ok(txt, 'a two-label relative name must resolve')
    assert.match(txt[6], /^v=DKIM1/)
  })

  it('answers PING with a bare END', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask(['PING'])
    assert.equal(dataLines(out).length, 0)
    assert.ok(out.includes('END'))
  })

  it('returns no data for a zone this nameserver does not serve', async (t) => {
    if (skip) return t.skip(skip)

    const out = await ask([`Q\twww.not-ours.test\tIN\tA\t-1\t127.0.0.1`])
    assert.equal(dataLines(out).length, 0)
  })
})
