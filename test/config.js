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
import coredns from '../lib/coredns.js'
import knot from '../lib/knot.js'
import maradns from '../lib/maradns.js'
import nsd from '../lib/nsd.js'
import {
  toBindConfig,
  toCorefileConfig,
  toKnotConfig,
  toMaradnsConfig,
  toNameserverConfig,
  toNsdConfig,
} from '../lib/config.js'
import { parseConfig as parseBind } from '../lib/bind.js'
import { parseConfig as parseCorefile } from '../lib/coredns.js'
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

describe('AXFR notify directives', () => {
  // NOTIFY only helps if the primary also permits the transfer that follows, so
  // the generators emit the ACL alongside it from the same notify list.
  const secondaries = ['192.0.2.53', '2001:db8::53']

  it('bind grants transfer and also-notify per zone', async () => {
    const text = toBindConfig(zones, { notify: secondaries })

    assert.match(text, /allow-transfer \{ 192\.0\.2\.53; 2001:db8::53; \};/)
    assert.match(text, /notify yes;/)
    assert.match(text, /also-notify \{ 192\.0\.2\.53; 2001:db8::53; \};/)
    // One set per zone, not a single global block.
    assert.equal(text.match(/also-notify/g).length, zones.size)

    const back = await roundTrip(bind, text, 'named-notify.conf', '/etc/zones')
    assert.equal(back.get('example.com'), resolved('/etc/zones', 'example.com.zone'))
  })

  it('nsd pairs notify with provide-xfr', async () => {
    const text = toNsdConfig(zones, { notify: secondaries })

    assert.match(text, /\tnotify: 192\.0\.2\.53 NOKEY/)
    assert.match(text, /\tprovide-xfr: 192\.0\.2\.53 NOKEY/)
    assert.equal(text.match(/provide-xfr:/g).length, zones.size * secondaries.length)

    const back = await roundTrip(nsd, text, 'nsd-notify.conf', '/etc/zones')
    assert.equal(back.size, zones.size)
  })

  it('knot declares remotes and an acl, and references them by id', async () => {
    const text = toKnotConfig(zones, { notify: secondaries })

    assert.match(text, /remote:/)
    assert.match(text, /- id: nictool_secondary_1\n {4}address: 192\.0\.2\.53/)
    assert.match(text, /acl:/)
    assert.match(text, /- id: nictool_secondary_1_xfr/)
    assert.match(text, /action: transfer/)
    assert.match(text, /notify: \[nictool_secondary_1, nictool_secondary_2\]/)
    assert.match(text, /acl: \[nictool_secondary_1_xfr, nictool_secondary_2_xfr\]/)

    const back = await roundTrip(knot, text, 'knot-notify.conf', '/etc/zones')
    assert.equal(back.size, zones.size)
  })

  it('emits nothing extra when no secondaries are configured', () => {
    for (const [gen, word] of [
      [toBindConfig, 'also-notify'],
      [toNsdConfig, 'provide-xfr'],
      [toKnotConfig, 'acl:'],
    ]) {
      assert.doesNotMatch(gen(zones), new RegExp(word))
    }
  })

  it('strips a port before writing an address into a config file', () => {
    const text = toBindConfig(zones, {
      notify: ['192.0.2.53:5353', '[2001:db8::53]:5353'],
    })
    assert.match(text, /\{ 192\.0\.2\.53; 2001:db8::53; \}/)
    assert.doesNotMatch(text, /5353/)
  })
})

describe('CoreDNS Corefile', () => {
  it('gives each zone its own server block with a file plugin', () => {
    const text = toCorefileConfig(zones)
    assert.match(text, /^example\.com \{$/m)
    assert.match(text, /^ {4}file example\.com\.zone$/m)
    assert.match(text, /^sub\.example\.net \{$/m)
  })

  it('round-trips through getZones', async () => {
    const back = await roundTrip(
      coredns,
      toCorefileConfig(zones),
      'Corefile',
      '/etc/coredns',
    )
    assert.equal(back.size, 2)
    assert.equal(back.get('example.com'), resolved('/etc/coredns', 'example.com.zone'))
    assert.equal(
      back.get('sub.example.net'),
      resolved('/etc/coredns', 'sub.example.net.zone'),
    )
  })

  it('appends a port to the block header when asked', async () => {
    const text = toCorefileConfig(zones, { port: 1053 })
    assert.match(text, /^example\.com:1053 \{$/m)
    // The port is part of the header, not part of the zone name.
    const back = await roundTrip(coredns, text, 'Corefile-port', '/etc/coredns')
    assert.equal(back.has('example.com'), true)
  })

  it('nests reload inside the file plugin', async () => {
    const text = toCorefileConfig(zones, { reload: '15s' })
    assert.match(text, /file example\.com\.zone \{/)
    assert.match(text, /^ {8}reload 15s$/m)
    const back = await roundTrip(coredns, text, 'Corefile-reload', '/etc/coredns')
    assert.equal(back.size, 2, 'a nested plugin block must not hide the zone')
  })

  it('turns notify targets into a transfer block, which is the AXFR ACL too', async () => {
    const text = toCorefileConfig(zones, { notify: ['192.0.2.53', '192.0.2.54:5353'] })
    assert.match(text, /^ {4}transfer \{$/m)
    assert.match(text, /^ {8}to 192\.0\.2\.53 192\.0\.2\.54$/m)
    assert.doesNotMatch(text, /5353/, 'the port belongs to NOTIFY, not the ACL')
    assert.equal(text.match(/transfer \{/g).length, zones.size, 'scoped per zone')

    const back = await roundTrip(coredns, text, 'Corefile-xfr', '/etc/coredns')
    assert.equal(back.size, 2)
  })

  it('carries extra plugin lines into every block', () => {
    const text = toCorefileConfig(zones, { plugins: ['log', 'errors'] })
    assert.equal(text.match(/^ {4}log$/gm).length, zones.size)
    assert.equal(text.match(/^ {4}errors$/gm).length, zones.size)
  })

  it('is reachable through toNameserverConfig', () => {
    assert.match(toNameserverConfig('coredns', zones), /file example\.com\.zone/)
  })
})

describe('Corefile parser', () => {
  it('keeps an unknown nested plugin rather than failing the import', async () => {
    const text = [
      'example.com {',
      '    file example.com.zone',
      '    forward . 8.8.8.8 {',
      '        max_fails 2',
      '    }',
      '    cache 30',
      '}',
    ].join('\n')
    const back = await roundTrip(coredns, text, 'Corefile-unknown', '/etc/coredns')
    assert.equal(back.get('example.com'), resolved('/etc/coredns', 'example.com.zone'))
  })

  it('ignores comments and blank lines', async () => {
    const text = '# a comment\n\nexample.com {\n    file z.zone # trailing\n}\n'
    const back = await roundTrip(coredns, text, 'Corefile-comments', '/etc/coredns')
    assert.equal(back.get('example.com'), resolved('/etc/coredns', 'z.zone'))
  })

  it('honours zone names given to the file plugin over the header', async () => {
    const text = 'server.local {\n    file shared.zone a.example b.example\n}\n'
    const back = await roundTrip(coredns, text, 'Corefile-multi', '/etc/coredns')
    assert.deepEqual([...back.keys()].sort(), ['a.example', 'b.example'])
  })

  it('skips a block with no file plugin', async () => {
    const text = '. {\n    forward . 8.8.8.8\n}\n'
    const back = await roundTrip(coredns, text, 'Corefile-nofile', '/etc/coredns')
    assert.equal(back.size, 0)
  })

  it('refuses an unclosed block', () => {
    assert.throws(
      () => coredns.default?.parseConfig ?? parseCorefile('example.com {\n    file z\n'),
      /unclosed block/,
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
  it('dispatches by nameserver type', () => {
    assert.match(toNameserverConfig('bind', zones), /zone "example\.com"/)
    assert.match(toNameserverConfig('maradns', zones), /csv2 = \{\}/)
    assert.match(toNameserverConfig('nsd', zones), /zonefile:/)
    assert.match(toNameserverConfig('knot', zones), /- domain: example\.com/)
  })

  it('returns null for a type with no config file', () => {
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
