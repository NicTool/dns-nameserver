// MaradnsPublisher: csv2 zone files plus the mararc that declares them.
//
// MaraDNS reads neither RFC 1035 zone files nor a compiled database, so this
// is its own format end to end. The mararc is checked by parsing it back with
// the reader NicTool uses to import an existing MaraDNS server.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after, beforeEach } from 'node:test'

import maradns from '../lib/maradns.js'
import MaradnsPublisher from '../lib/publisher/maradns.js'

let dir

const NS = { owner: '@', type: 'NS', dname: 'ns1.mara.test.' }

const zoneMap = (records, extra = {}) =>
  new Map([
    [
      'mara.test',
      {
        zone: {
          zone: 'mara.test',
          ttl: 300,
          serial: 5,
          mailaddr: 'hostmaster.mara.test.',
          refresh: 7200,
          retry: 3600,
          expire: 1209600,
          minimum: 3600,
          ...extra,
        },
        records,
      },
    ],
  ])

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-mara-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
})

const publish = (records, opts = {}) =>
  new MaradnsPublisher({ path: dir, ...opts }).publish(zoneMap(records))

const zoneText = () => fs.readFile(path.join(dir, 'mara.test.csv2'), 'utf8')

describe('MaradnsPublisher zone files', () => {
  it('writes a .csv2 file per zone', async () => {
    const out = await publish([NS])

    assert.equal(out.kind, 'maradns')
    assert.deepEqual(
      out.files.map((f) => path.basename(f.path)),
      ['mara.test.csv2'],
    )
  })

  // MaraDNS 3.5's default csv2_tilde_handling=2 accepts tildes only if "the
  // first record can not be a TXT, WKS, or LOC record" (mararc.5). Every record
  // this publisher writes is tilde-terminated, so the export is only loadable
  // because zoneToRRs always puts the synthesized SOA first. If that ordering
  // ever changed, modern MaraDNS would reject the whole zone.
  it('leads with SOA, which is what makes the tildes legal', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-mara-soa-'))
    try {
      const publisher = new MaradnsPublisher({ path: out })
      await publisher.publish(
        new Map([
          [
            'first.example',
            {
              zone: { zone: 'first.example', ttl: 300, serial: 1 },
              // A TXT first in record order, to prove the SOA still leads.
              records: [
                { id: 1, type: 'TXT', owner: '@', data: 'must not be first', ttl: 300 },
                { id: 2, type: 'A', owner: '@', address: '192.0.2.1', ttl: 300 },
              ],
            },
          ],
        ]),
      )

      const text = await fs.readFile(path.join(out, 'first.example.csv2'), 'utf8')
      const records = text
        .split('\n')
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('/'))
      assert.match(records[0], /\sSOA\s/, 'the first record must be the SOA')
      assert.match(records[0], /~$/, 'and it is tilde-terminated like the rest')
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  })

  it('emits csv2 records, not RFC 1035 ones', async () => {
    await publish([NS, { owner: 'www', type: 'A', address: '192.0.2.1', ttl: 300 }])
    const text = await zoneText()

    // csv2 marks the TTL with a leading + and terminates records with ~
    assert.match(text, /^www\.mara\.test\.\s+\+300\s+A\s+192\.0\.2\.1 ~$/m)
    assert.doesNotMatch(text, /\bIN\b/, 'the IN class belongs to RFC 1035, not csv2')
  })

  it('synthesizes the SOA from the zone columns', async () => {
    await publish([NS])

    assert.match(
      await zoneText(),
      /mara\.test\.\s+SOA\s+ns1\.mara\.test\.\s+hostmaster\.mara\.test\./,
    )
  })

  it('publishes every type the resource-record library supports', async () => {
    await publish([
      NS,
      { owner: '@', type: 'MX', exchange: 'mail.mara.test.', preference: 10 },
      { owner: '@', type: 'TXT', data: 'v=spf1 -all' },
      { owner: 'v6', type: 'AAAA', address: '2001:db8::1' },
    ])
    const text = await zoneText()

    assert.match(text, /MX\s+10/)
    assert.match(text, /TXT/)
    assert.match(text, /AAAA/)
  })

  it('comments out a record it cannot build, keeping the zone', async () => {
    await publish([NS, { owner: 'bad', type: 'NOSUCHTYPE', address: 'x' }])
    const text = await zoneText()

    assert.match(text, /^# bad\.mara\.test\. NOSUCHTYPE: /m)
    assert.match(text, /SOA/, 'the rest of the zone survives')
  })

  it('terminates records with ~ by default, as MaraDNS 2.x csv2 does', async () => {
    await publish([NS, { owner: 'www', type: 'A', address: '192.0.2.1', ttl: 300 }])

    assert.match(await zoneText(), /A\t192\.0\.2\.1 ~$/m)
  })

  it('omits the terminator for MaraDNS 1.2, which rejects it', async () => {
    // csv2(5) for 1.2 documents `name [+ttl] [rtype] rdata` with no
    // terminator; its parser counts the fields each type needs and treats a
    // trailing ~ as an unexpected character, refusing the whole zone.
    await publish([NS, { owner: 'www', type: 'A', address: '192.0.2.1', ttl: 300 }], {
      terminator: '',
    })
    const text = await zoneText()

    assert.match(text, /A\t192\.0\.2\.1$/m)
    assert.doesNotMatch(text, /~/)
  })

  it('refuses a zone name that would escape the output directory', async () => {
    const pub = new MaradnsPublisher({ path: dir })
    const evil = new Map([['../escape', { zone: { zone: '../escape' }, records: [] }]])

    await assert.rejects(() => pub.publish(evil), /unsafe zone name/)
  })
})

describe('MaradnsPublisher mararc', () => {
  it('writes no config unless asked', async () => {
    const out = await publish([NS])

    assert.equal(out.config, null)
    assert.equal(
      out.files.some((f) => path.basename(f.path) === 'mararc'),
      false,
    )
  })

  it('declares every published zone', async () => {
    const out = await publish([NS], { config: {} })

    assert.equal(path.basename(out.config), 'mararc')
    const text = await fs.readFile(out.config, 'utf8')
    assert.match(text, /csv2\["mara\.test\."\] = "mara\.test\.csv2"/)
  })

  it('round-trips through the mararc reader', async () => {
    const out = await publish([NS], { config: {} })
    const zones = await maradns.getZones(out.config, dir)

    assert.deepEqual([...zones.keys()], ['mara.test.'])
    assert.equal(zones.get('mara.test.'), path.join(dir, 'mara.test.csv2'))
  })

  it('points chroot_dir at the zone directory by default', async () => {
    const out = await publish([NS], { config: {} })

    // Compared as a string, not a regex: a Windows temp path is full of
    // backslashes, and `Temp\nt-mara...` would compile as escape sequences.
    const text = await fs.readFile(out.config, 'utf8')

    assert.ok(text.includes(`chroot_dir = "${dir}"`), text)
  })

  it('honours an explicit config path and globals', async () => {
    const file = path.join(dir, 'etc', 'mararc')
    const out = await publish([NS], {
      config: { file, bindAddress: '127.0.0.1', globals: { maradns_uid: 99 } },
    })

    assert.equal(out.config, file)
    const text = await fs.readFile(file, 'utf8')
    assert.match(text, /ipv4_bind_addresses = "127\.0\.0\.1"/)
    assert.match(text, /maradns_uid = 99/)
  })
})
