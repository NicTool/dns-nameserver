import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import MemoryPublisher from '../lib/publisher/memory.js'
import Rfc1035Publisher from '../lib/publisher/rfc1035.js'
import TinydnsCdbPublisher from '../lib/publisher/tinydns-cdb.js'

function zonesFixture() {
  const out = new Map()
  out.set('example.com', {
    zone: {
      id: 1,
      name: 'example.com',
      ttl: 300,
      serial: 2026010101,
      mailaddr: 'ns1.example.com',
      rname: 'hostmaster.example.com',
    },
    records: [
      { id: 10, zid: 1, type: 'A', name: '@', address: '192.0.2.10', ttl: 300 },
      { id: 11, zid: 1, type: 'A', name: 'www', address: '192.0.2.20', ttl: 300 },
      {
        id: 12,
        zid: 1,
        type: 'MX',
        name: '@',
        address: 'mail.example.com',
        weight: 10,
        ttl: 300,
      },
      { id: 13, zid: 1, type: 'TXT', name: '@', address: 'v=spf1 -all', ttl: 300 },
    ],
  })
  return out
}

describe('MemoryPublisher', function () {
  it('swaps in the zone map and resolves via longest-suffix match', async () => {
    const pub = new MemoryPublisher()
    await pub.publish(zonesFixture())
    const z = pub.findZone('www.example.com')
    assert.ok(z)
    assert.strictEqual(z.zone.name, 'example.com')
    assert.strictEqual(pub.findZone('nowhere.test'), null)
  })
})

describe('Rfc1035Publisher', function () {
  it('writes RFC1035 zone files to disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-pub-'))
    try {
      const pub = new Rfc1035Publisher({ path: dir })
      const out = await pub.publish(zonesFixture())
      assert.strictEqual(out.directory, dir)
      assert.strictEqual(out.files.length, 1)

      const text = await fs.readFile(path.join(dir, 'example.com.zone'), 'utf8')
      assert.match(text, /\$ORIGIN example\.com\./)
      assert.match(text, /\$TTL 300/)
      assert.match(text, /IN\s+SOA\s+ns1\.example\.com\./)
      assert.match(text, /@\s+300\s+IN\s+A\s+192\.0\.2\.10/)
      assert.match(text, /www\s+300\s+IN\s+A\s+192\.0\.2\.20/)
      assert.match(text, /@\s+300\s+IN\s+MX\s+10 mail\.example\.com\./)
      assert.match(text, /IN\s+TXT\s+"v=spf1 -all"/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('escapes backslashes and quotes in TXT character-strings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-pub-'))
    try {
      const zones = zonesFixture()
      zones.get('example.com').records.push(
        { id: 14, zid: 1, type: 'TXT', name: 'quote', address: 'say "hi"', ttl: 300 },
        // a trailing backslash swallowed the closing quote before it was doubled
        { id: 15, zid: 1, type: 'TXT', name: 'slash', address: 'c:\\path\\', ttl: 300 },
      )

      const pub = new Rfc1035Publisher({ path: dir })
      await pub.publish(zones)
      const text = await fs.readFile(path.join(dir, 'example.com.zone'), 'utf8')

      assert.match(text, /quote\s+300\s+IN\s+TXT\s+"say \\"hi\\""$/m)
      assert.match(text, /slash\s+300\s+IN\s+TXT\s+"c:\\\\path\\\\"$/m)

      // every emitted character-string closes on an unescaped quote
      for (const line of text.split('\n').filter((l) => /\sTXT\s/.test(l))) {
        const value = line.slice(line.indexOf('"'))
        assert.match(value, /^"(?:[^"\\]|\\.)*"(?: "(?:[^"\\]|\\.)*")*$/, line)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('chunks long TXT values on the unescaped length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-pub-'))
    try {
      const zones = zonesFixture()
      zones.get('example.com').records.push({
        id: 16,
        zid: 1,
        type: 'TXT',
        name: 'long',
        address: '"'.repeat(300),
        ttl: 300,
      })

      const pub = new Rfc1035Publisher({ path: dir })
      await pub.publish(zones)
      const text = await fs.readFile(path.join(dir, 'example.com.zone'), 'utf8')

      const line = text.split('\n').find((l) => l.startsWith('long'))
      const chunks = line.slice(line.indexOf('"')).split('" "')
      assert.strictEqual(chunks.length, 2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('TinydnsCdbPublisher', function () {
  it('throws a clear not-yet-implemented error', async () => {
    const pub = new TinydnsCdbPublisher()
    await assert.rejects(() => pub.publish(new Map()), /not yet implemented/)
  })
})
