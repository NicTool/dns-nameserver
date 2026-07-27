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
