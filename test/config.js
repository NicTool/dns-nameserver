// Nameserver config generation.
//
// The contract is a round trip: what these emit must parse back through the
// matching parseConfig / getZones in lib/{bind,knot,maradns,nsd}.js, which are
// the readers NicTool already uses to import an existing server's config.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import bind from '../lib/bind.js'
import knot from '../lib/knot.js'
import maradns from '../lib/maradns.js'
import nsd from '../lib/nsd.js'
import {
  toBindConfig,
  toKnotConfig,
  toMaradnsConfig,
  toNameserverConfig,
  toNsdConfig,
} from '../lib/config.js'
import { parseConfig as parseBind } from '../lib/bind.js'
import { parseConfig as parseKnot } from '../lib/knot.js'
import { parseConfig as parseMararc } from '../lib/maradns.js'
import { parseConfig as parseNsd } from '../lib/nsd.js'

const zones = new Map([
  ['example.com', '/etc/zones/example.com.zone'],
  ['sub.example.net', '/etc/zones/sub.example.net.zone'],
])

let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-nsconf-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// getZones resolves a zone file against basePath with path.resolve, so the
// expected value has to be built the same way: on Windows that yields a
// drive-qualified path with backslashes, not the POSIX string passed in.
const resolved = (basePath, name) => path.resolve(basePath, name)

/** Write the config, then read it back with the module's own getZones(). */
async function roundTrip(mod, text, name, basePath) {
  const file = path.join(dir, name)
  await fs.writeFile(file, text)
  return mod.getZones(file, basePath)
}

describe('BIND named.conf', () => {
  it('declares every zone with its type and file', () => {
    const text = toBindConfig(zones)

    assert.match(text, /zone "example\.com" \{/)
    assert.match(text, /type master;/)
    assert.match(text, /file "example\.com\.zone";/)
  })

  it('parses back through the BIND parser', () => {
    const parsed = parseBind(toBindConfig(zones))

    assert.deepEqual(
      parsed.zone.map((z) => z.name),
      ['example.com', 'sub.example.net'],
    )
    assert.equal(parsed.zone[0].type, 'master')
  })

  it('round-trips through getZones', async () => {
    const back = await roundTrip(bind, toBindConfig(zones), 'named.conf', '/etc/zones')

    assert.deepEqual([...back.keys()], ['example.com', 'sub.example.net'])
    assert.equal(back.get('example.com'), resolved('/etc/zones', 'example.com.zone'))
  })

  it('emits an options block when given a directory', () => {
    assert.match(
      toBindConfig(zones, { directory: '/var/named' }),
      /directory "\/var\/named";/,
    )
  })

  it('honours a non-master zone type', () => {
    assert.match(toBindConfig(zones, { type: 'slave' }), /type slave;/)
  })
})

describe('NSD nsd.conf', () => {
  it('parses back through the NSD parser', () => {
    const parsed = parseNsd(toNsdConfig(zones))

    assert.deepEqual(
      parsed.zone.map((z) => z.name),
      ['example.com', 'sub.example.net'],
    )
    assert.equal(parsed.zone[0].zonefile, '/etc/zones/example.com.zone')
  })

  it('round-trips through getZones', async () => {
    const back = await roundTrip(nsd, toNsdConfig(zones), 'nsd.conf', '/etc/zones')

    assert.deepEqual([...back.keys()], ['example.com', 'sub.example.net'])
  })

  it('emits a server block', () => {
    const text = toNsdConfig(zones, { server: { username: 'nsd', 'server-count': 2 } })

    assert.match(text, /server:/)
    assert.match(text, /username: nsd/)
  })
})

describe('Knot knot.conf', () => {
  it('parses back through the Knot parser', () => {
    const parsed = parseKnot(toKnotConfig(zones))

    assert.deepEqual(
      parsed.zone.map((z) => z.domain),
      ['example.com', 'sub.example.net'],
    )
    assert.equal(parsed.zone[0].file, '/etc/zones/example.com.zone')
  })

  it('round-trips through getZones', async () => {
    const back = await roundTrip(knot, toKnotConfig(zones), 'knot.conf', '/etc/zones')

    assert.deepEqual([...back.keys()], ['example.com', 'sub.example.net'])
  })

  it('emits a storage template when asked', () => {
    assert.match(
      toKnotConfig(zones, { storage: '/var/lib/knot' }),
      /storage: \/var\/lib\/knot/,
    )
  })
})

describe('MaraDNS mararc', () => {
  it('initializes csv2 before assigning into it', () => {
    const text = toMaradnsConfig(zones)
    const initAt = text.indexOf('csv2 = {}')
    const firstZoneAt = text.indexOf('csv2["example.com."]')

    assert.ok(initAt >= 0, 'csv2 must be initialized')
    assert.ok(initAt < firstZoneAt, 'MaraDNS will not load zones assigned before it')
  })

  it('keys zones with the root dot MaraDNS expects', () => {
    assert.match(
      toMaradnsConfig(zones),
      /csv2\["example\.com\."\] = "example\.com\.zone"/,
    )
  })

  it('parses back through the mararc parser', () => {
    const parsed = parseMararc(toMaradnsConfig(zones))

    assert.equal(parsed['csv2["example.com."]'], 'example.com.zone')
    assert.equal(parsed['csv2["sub.example.net."]'], 'sub.example.net.zone')
  })

  it('round-trips through getZones', async () => {
    const back = await roundTrip(
      maradns,
      toMaradnsConfig(zones),
      'mararc',
      '/etc/maradns',
    )

    assert.deepEqual([...back.keys()], ['example.com.', 'sub.example.net.'])
    assert.equal(back.get('example.com.'), resolved('/etc/maradns', 'example.com.zone'))
  })

  it('emits the chroot and bind address', () => {
    const text = toMaradnsConfig(zones, {
      chrootDir: '/etc/maradns',
      bindAddress: '127.0.0.1',
    })

    assert.match(text, /chroot_dir = "\/etc\/maradns"/)
    assert.match(text, /ipv4_bind_addresses = "127\.0\.0\.1"/)
  })

  it('writes numeric globals unquoted, as mararc expects', () => {
    assert.match(
      toMaradnsConfig(zones, { globals: { maradns_uid: 99 } }),
      /maradns_uid = 99$/m,
    )
  })
})

describe('toNameserverConfig', () => {
  it('dispatches by engine name', () => {
    assert.match(toNameserverConfig('bind', zones), /zone "example\.com"/)
    assert.match(toNameserverConfig('maradns', zones), /csv2 = \{\}/)
    assert.match(toNameserverConfig('nsd', zones), /zonefile:/)
    assert.match(toNameserverConfig('knot', zones), /- domain: example\.com/)
  })

  it('returns null for an engine with no config file', () => {
    // tinydns compiles everything into data.cdb; there is nothing to declare.
    assert.equal(toNameserverConfig('tinydns', zones), null)
    assert.equal(toNameserverConfig('native', zones), null)
  })

  it('handles an empty zone set', () => {
    for (const fmt of ['bind', 'knot', 'maradns', 'nsd']) {
      assert.ok(typeof toNameserverConfig(fmt, new Map()) === 'string')
    }
  })
})
