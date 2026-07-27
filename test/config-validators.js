// Validate generated output with the nameservers' own tools.
//
// Round-tripping through NicTool's parsers proves we can read back what we
// wrote; only the servers themselves can say whether they will accept it.
// Each check skips when its binary is absent.
//
//   named-checkconf / named-checkzone   named.conf and the zone files
//   nsd-checkconf   nsd.conf
//   knotc conf-check  knot.conf
//   nsd-checkzone / kzonecheck   the RFC 1035 zone files
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, before, after } from 'node:test'

import { Rfc1035Publisher } from '../lib/publisher/rfc1035.js'

const execFileAsync = promisify(execFile)

function which(name) {
  for (const dir of [
    '',
    '/opt/local/sbin/',
    '/opt/local/bin/',
    '/opt/homebrew/sbin/',
    '/opt/homebrew/bin/',
  ]) {
    try {
      const cmd = dir ? dir + name : name
      execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
      return cmd
    } catch {
      /* keep looking */
    }
  }
  return null
}

const namedCheckConf = which('named-checkconf')
const namedCheckZone = which('named-checkzone')
const nsdCheckConf = which('nsd-checkconf')
const nsdCheckZone = which('nsd-checkzone')
const knotc = which('knotc')
const kzonecheck = which('kzonecheck')

const ZONE = 'val.test'

// A zone wide enough to exercise the rdata formats that differ between types:
// names, priorities, quoted character-strings, and the multi-field SRV/CAA.
const zones = new Map([
  [
    ZONE,
    {
      zone: {
        zone: ZONE,
        ttl: 300,
        serial: 7,
        mailaddr: `hostmaster.${ZONE}.`,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minimum: 3600,
      },
      records: [
        { type: 'NS', owner: '@', dname: `ns1.${ZONE}.`, ttl: 300 },
        { type: 'A', owner: 'ns1', address: '192.0.2.53', ttl: 300 },
        { type: 'A', owner: 'www', address: '192.0.2.1', ttl: 300 },
        { type: 'AAAA', owner: 'www', address: '2001:db8::1', ttl: 300 },
        { type: 'MX', owner: '@', exchange: `mail.${ZONE}.`, preference: 10, ttl: 300 },
        { type: 'A', owner: 'mail', address: '192.0.2.25', ttl: 300 },
        { type: 'TXT', owner: '@', data: 'v=spf1 -all', ttl: 300 },
        { type: 'TXT', owner: 'quoted', data: 'has "quotes" and \\ backslash', ttl: 300 },
        { type: 'CNAME', owner: 'alias', cname: `www.${ZONE}.`, ttl: 300 },
        {
          type: 'SRV',
          owner: '_sip._tcp',
          target: `sip.${ZONE}.`,
          port: 5060,
          weight: 10,
          priority: 20,
          ttl: 300,
        },
        { type: 'A', owner: 'sip', address: '192.0.2.60', ttl: 300 },
        {
          type: 'CAA',
          owner: '@',
          flags: 0,
          tag: 'issue',
          value: 'letsencrypt.org',
          ttl: 300,
        },
      ],
    },
  ],
])

let dir

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-nsval-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const publish = async (format) => {
  const out = path.join(dir, format)
  const artifacts = await new Rfc1035Publisher({
    path: out,
    config: { format },
  }).publish(zones)
  return { out, artifacts }
}

describe('generated zone files', () => {
  it('pass nsd-checkzone', async (t) => {
    if (!nsdCheckZone) return t.skip('nsd-checkzone is not installed')

    const { out } = await publish('nsd')
    const { stdout } = await execFileAsync(nsdCheckZone, [
      ZONE,
      path.join(out, `${ZONE}.zone`),
    ])

    assert.match(stdout, /is ok/)
  })

  it('pass kzonecheck', async (t) => {
    if (!kzonecheck) return t.skip('kzonecheck is not installed')

    const { out } = await publish('knot')
    // Exits non-zero and rejects on any semantic error, so reaching here is the assertion.
    await assert.doesNotReject(() =>
      execFileAsync(kzonecheck, ['-o', ZONE, path.join(out, `${ZONE}.zone`)]),
    )
  })
})

describe('generated named.conf', () => {
  it('passes named-checkconf', async (t) => {
    if (!namedCheckConf) return t.skip('named-checkconf is not installed')

    const { artifacts } = await publish('bind')
    await assert.doesNotReject(() => execFileAsync(namedCheckConf, [artifacts.config]))
  })

  it('passes named-checkzone', async (t) => {
    if (!namedCheckZone) return t.skip('named-checkzone is not installed')

    const { out } = await publish('bind')
    const { stdout } = await execFileAsync(namedCheckZone, [
      ZONE,
      path.join(out, `${ZONE}.zone`),
    ])

    assert.match(stdout, /loaded serial/)
    assert.match(stdout, /OK/)
  })
})

describe('generated nsd.conf', () => {
  it('passes nsd-checkconf', async (t) => {
    if (!nsdCheckConf) return t.skip('nsd-checkconf is not installed')

    const { artifacts } = await publish('nsd')
    await assert.doesNotReject(() => execFileAsync(nsdCheckConf, [artifacts.config]))
  })

  it('resolves the zone file NSD would load', async (t) => {
    if (!nsdCheckConf) return t.skip('nsd-checkconf is not installed')

    const { out, artifacts } = await publish('nsd')
    // Ask NSD itself which file it would read for this zone.
    const { stdout } = await execFileAsync(nsdCheckConf, [
      '-z',
      ZONE,
      '-o',
      'zonefile',
      artifacts.config,
    ])

    assert.equal(stdout.trim(), path.join(out, `${ZONE}.zone`))
  })
})

describe('generated knot.conf', () => {
  it('passes knotc conf-check', async (t) => {
    if (!knotc) return t.skip('knotc is not installed')

    const { artifacts } = await publish('knot')
    const { stdout } = await execFileAsync(knotc, ['-c', artifacts.config, 'conf-check'])

    assert.match(stdout, /Configuration is valid/)
  })
})
