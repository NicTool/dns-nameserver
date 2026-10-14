// FileSource reads the NicTool file store in either codec.
//
// Regression guard for a field-name mismatch that made API-created zones
// invisible to the engines: @nictool/validate names the domain `zone`, and that
// is now the only spelling this package reads.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import FileSource from '../lib/source/file.js'
import { zoneToRRs } from '../lib/zone-rrs.js'

let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-source-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const writeJson = (base, obj) =>
  fs.writeFile(path.join(dir, `${base}.json`), JSON.stringify(obj, null, 1))

describe('FileSource', () => {
  it("reads a JSON store keyed on the API's `zone` field", async () => {
    await writeJson('zone', {
      zone: [{ id: 1, zone: 'example.com', ttl: 3600, serial: 1 }],
    })
    await writeJson('zone_record', {
      zone_record: [{ id: 1, zid: 1, type: 'A', owner: 'www', address: '192.0.2.7' }],
    })

    const zones = await new FileSource({ path: dir, format: 'json' }).getZones({})

    assert.deepEqual([...zones.keys()], ['example.com'])
    assert.equal(zones.get('example.com').records.length, 1)
  })

  it('ignores a zone keyed on the pre-v3 `name` field', async () => {
    await writeJson('zone', { zone: [{ id: 2, name: 'legacy.test', ttl: 3600 }] })
    await writeJson('zone_record', { zone_record: [] })

    const zones = await new FileSource({ path: dir, format: 'json' }).getZones({})

    assert.equal(zones.size, 0, '`zone` is the only accepted spelling')
  })

  it('drops soft-deleted zones and records', async () => {
    await writeJson('zone', {
      zone: [
        { id: 1, zone: 'live.test' },
        { id: 2, zone: 'gone.test', deleted: true },
      ],
    })
    await writeJson('zone_record', {
      zone_record: [
        { id: 1, zid: 1, type: 'A', owner: 'a', address: '192.0.2.1' },
        { id: 2, zid: 1, type: 'A', owner: 'b', address: '192.0.2.2', deleted: true },
      ],
    })

    const zones = await new FileSource({ path: dir, format: 'json' }).getZones({})

    assert.deepEqual([...zones.keys()], ['live.test'])
    assert.equal(zones.get('live.test').records.length, 1)
  })

  it('skips a zone with no usable name rather than keying on undefined', async () => {
    await writeJson('zone', { zone: [{ id: 9, ttl: 3600 }] })
    await writeJson('zone_record', { zone_record: [] })

    const zones = await new FileSource({ path: dir, format: 'json' }).getZones({})

    assert.equal(zones.size, 0)
  })

  it('returns an empty map when the store files are absent', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-source-empty-'))
    const zones = await new FileSource({ path: empty, format: 'json' }).getZones({})

    assert.equal(zones.size, 0)
    await fs.rm(empty, { recursive: true, force: true })
  })

  it('reads the TOML codec', async () => {
    await fs.writeFile(
      path.join(dir, 'zone.toml'),
      '[[zone]]\nid = 1\nzone = "toml.test"\nttl = 3600\n',
    )
    await fs.writeFile(path.join(dir, 'zone_record.toml'), '')

    const zones = await new FileSource({ path: dir, format: 'toml' }).getZones({})

    assert.deepEqual([...zones.keys()], ['toml.test'])
  })
})

describe('FileSource nameserver assignments', () => {
  before(async () => {
    await writeJson('zone', {
      zone: [
        { id: 1, zone: 'assigned.test', ttl: 3600, nameservers: [7, 5, 6, 9] },
        { id: 2, zone: 'unassigned.test', ttl: 3600 },
      ],
    })
    await writeJson('zone_record', {
      zone_record: [
        {
          id: 1,
          zid: 1,
          type: 'NS',
          owner: 'assigned.test.',
          dname: 'ns2.example.net.',
          ttl: 60,
        },
        { id: 2, zid: 1, type: 'NS', owner: 'sub', dname: 'ns2.example.net.' },
        { id: 3, zid: 1, type: 'A', owner: 'www', address: '192.0.2.8' },
      ],
    })
    await writeJson('nameserver', {
      nameserver: [
        { id: 5, name: 'ns1.example.net.', ttl: 3600 },
        { id: 6, name: 'ns0.example.net.', ttl: 3600, deleted: true },
        { id: 7, name: 'ns2.example.net', ttl: 7200 },
      ],
    })
  })

  const source = () => new FileSource({ path: dir, format: 'json' })

  it('serves a nameserver only the zones assigned to it', async () => {
    assert.deepEqual(
      [...(await source().getZones({ nameserverId: 5 })).keys()],
      ['assigned.test'],
    )
    assert.deepEqual(
      [...(await source().getZones({ nameserverId: '7' })).keys()],
      ['assigned.test'],
    )
    assert.equal((await source().getZones({ nameserverId: 8 })).size, 0)
  })

  it('returns every zone without a nameserverId', async () => {
    assert.deepEqual(
      [...(await source().getZones({})).keys()],
      ['assigned.test', 'unassigned.test'],
    )
  })

  it('leads with the active assigned nameservers as apex NS, lowest id first', async () => {
    const { records } = (await source().getZones({})).get('assigned.test')
    assert.deepEqual(
      records.map((r) => [r.type, r.owner, r.dname ?? r.address, r.ttl]),
      [
        ['NS', 'assigned.test.', 'ns1.example.net.', 3600],
        ['NS', 'assigned.test.', 'ns2.example.net.', 7200],
        ['NS', 'sub', 'ns2.example.net.', undefined],
        ['A', 'www', '192.0.2.8', undefined],
      ],
    )
  })

  it('makes the lowest assigned nameserver the SOA MNAME', async () => {
    const { zone, records } = (await source().getZones({})).get('assigned.test')
    assert.equal(
      zoneToRRs(zone.zone, zone, records).rrs[0].get('mname'),
      'ns1.example.net.',
    )
  })

  it('adds no NS to a zone without assignments', async () => {
    const { records } = (await source().getZones({})).get('unassigned.test')
    assert.deepEqual(records, [])
  })
})
