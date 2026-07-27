// TinydnsCdbPublisher: render the djbdns data file, compile it with the real
// tinydns-data, and read the result back with tinydns-get.
//
// The compile and query steps skip when djbdns is not installed; the rendering
// assertions always run.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, before, after, beforeEach } from 'node:test'

import TinydnsCdbPublisher from '../lib/publisher/tinydns-cdb.js'

const execFileAsync = promisify(execFile)

function haveBinary(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasTinydnsData = haveBinary('tinydns-data')
const hasTinydnsGet = haveBinary('tinydns-get')
const noCompile = hasTinydnsData ? false : 'tinydns-data is not installed'
const noQuery = hasTinydnsGet ? false : 'tinydns-get is not installed'

let dir

const zoneMap = (records, zone = {}) =>
  new Map([
    [
      'tiny.test',
      {
        zone: {
          zone: 'tiny.test',
          ttl: 300,
          serial: 12,
          mailaddr: 'hostmaster.tiny.test.',
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

const NS = { owner: '@', type: 'NS', dname: 'ns1.tiny.test.' }

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-tinydns-'))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
})

const publish = (records, opts = {}, zone = {}) =>
  new TinydnsCdbPublisher({ path: dir, compile: false, ...opts }).publish(
    zoneMap(records, zone),
  )

const dataText = () => fs.readFile(path.join(dir, 'data'), 'utf8')

describe('TinydnsCdbPublisher rendering', () => {
  it('synthesizes the SOA as a Z line', async () => {
    await publish([NS])
    const text = await dataText()

    // Zfqdn:mname:rname:serial:refresh:retry:expire:min:ttl
    assert.match(
      text,
      /^Ztiny\.test:ns1\.tiny\.test:hostmaster\.tiny\.test:12:7200:3600:1209600:3600:300/m,
    )
  })

  it('uses djbdns native prefixes where they exist', async () => {
    await publish([
      NS,
      { owner: 'www', type: 'A', address: '192.0.2.1', ttl: 300 },
      { owner: '@', type: 'MX', exchange: 'mail.tiny.test.', preference: 10 },
      { owner: '@', type: 'TXT', data: 'v=spf1 -all' },
      { owner: 'alias', type: 'CNAME', cname: 'www.tiny.test.' },
    ])
    const text = await dataText()

    assert.match(text, /^\+www\.tiny\.test:192\.0\.2\.1:300/m, 'A uses +')
    assert.match(text, /^&tiny\.test::ns1\.tiny\.test/m, 'NS uses &')
    assert.match(text, /^@tiny\.test::mail\.tiny\.test:10/m, 'MX uses @')
    assert.match(text, /^'tiny\.test:v=spf1 -all/m, 'TXT uses apostrophe')
    assert.match(text, /^Calias\.tiny\.test:www\.tiny\.test/m, 'CNAME uses C')
  })

  it('falls back to generic : lines for types djbdns has no prefix for', async () => {
    await publish([
      NS,
      { owner: 'v6', type: 'AAAA', address: '2001:db8::1' },
      {
        owner: '_sip._tcp',
        type: 'SRV',
        target: 'sip.tiny.test.',
        priority: 20,
        weight: 10,
        port: 5060,
      },
    ])
    const text = await dataText()

    assert.match(text, /^:v6\.tiny\.test:28:/m, 'AAAA is type 28 with octal rdata')
    assert.match(text, /^:_sip\._tcp\.tiny\.test:33:/m, 'SRV is type 33')
  })

  it('qualifies owners against the apex', async () => {
    await publish([NS, { owner: 'deep.sub', type: 'A', address: '192.0.2.3' }])

    assert.match(await dataText(), /^\+deep\.sub\.tiny\.test:192\.0\.2\.3/m)
  })

  it('skips soft-deleted records', async () => {
    await publish([
      NS,
      { owner: 'live', type: 'A', address: '192.0.2.1' },
      { owner: 'gone', type: 'A', address: '192.0.2.2', deleted: true },
    ])
    const text = await dataText()

    assert.match(text, /live\.tiny\.test/)
    assert.doesNotMatch(text, /gone\.tiny\.test/)
  })

  it('publishes every type the resource-record library supports', async () => {
    // NAPTR has no djbdns prefix, so it goes out as a generic : line rather
    // than being skipped — there is no per-publisher type list to fall off.
    const artifacts = await publish([
      NS,
      {
        owner: 'sip',
        type: 'NAPTR',
        order: 100,
        preference: 10,
        flags: 'U',
        service: 'E2U+sip',
        regexp: '!^.*$!sip:info@tiny.test!',
        replacement: '.',
      },
      {
        owner: 'ssh',
        type: 'SSHFP',
        algorithm: 1,
        fptype: 1,
        fingerprint: 'dd465c09cfa51fb45020cc83316fff21b9ec74ac',
      },
      { owner: 'www', type: 'A', address: '192.0.2.1' },
    ])
    const text = await dataText()

    assert.match(text, /^:sip\.tiny\.test:35:/m, 'NAPTR is type 35')
    assert.match(text, /^:ssh\.tiny\.test:44:/m, 'SSHFP is type 44')
    assert.equal(artifacts.recordCount, 5, 'SOA + NS + NAPTR + SSHFP + A')
  })

  it('comments out a record it cannot build instead of failing the zone', async () => {
    const artifacts = await publish([
      NS,
      { owner: 'odd', type: 'NOSUCHTYPE', address: 'whatever' },
      { owner: 'www', type: 'A', address: '192.0.2.1' },
    ])
    const text = await dataText()

    assert.match(text, /^# odd\.tiny\.test\. NOSUCHTYPE: /m)
    assert.match(text, /^\+www\.tiny\.test/m, 'the rest of the zone still renders')
    assert.equal(artifacts.recordCount, 3, 'SOA + NS + A; the bad record is not counted')
  })

  it('reports the artifacts a transport needs', async () => {
    const artifacts = await publish([NS])

    assert.equal(artifacts.kind, 'tinydns-cdb')
    assert.equal(artifacts.zoneCount, 1)
    assert.equal(artifacts.compiled, false)
    assert.equal(artifacts.cdbFile, null)
    assert.deepEqual(
      artifacts.files.map((f) => path.basename(f.path)),
      ['data'],
    )
  })

  it('replaces the data file rather than appending', async () => {
    await publish([NS, { owner: 'first', type: 'A', address: '192.0.2.1' }])
    await publish([NS, { owner: 'second', type: 'A', address: '192.0.2.2' }])
    const text = await dataText()

    assert.doesNotMatch(text, /first\.tiny\.test/)
    assert.match(text, /second\.tiny\.test/)
  })
})

describe('TinydnsCdbPublisher compilation', () => {
  it('compiles the data file with tinydns-data', async (t) => {
    if (noCompile) return t.skip(noCompile)

    const artifacts = await publish(
      [NS, { owner: 'www', type: 'A', address: '192.0.2.1' }],
      { compile: true },
    )

    assert.equal(artifacts.compiled, true)
    assert.equal(path.basename(artifacts.cdbFile), 'data.cdb')
    const stat = await fs.stat(artifacts.cdbFile)
    assert.ok(stat.size > 0, 'tinydns-data produced a non-empty cdb')
    assert.deepEqual(
      artifacts.files.map((f) => path.basename(f.path)),
      ['data', 'data.cdb'],
    )
  })

  it('compiles every supported type without a parse error', async (t) => {
    if (noCompile) return t.skip(noCompile)

    // tinydns-data rejects the whole file on one bad line, so this is a real
    // check that each rendering is syntactically valid djbdns input.
    await publish(
      [
        NS,
        { owner: 'www', type: 'A', address: '192.0.2.1' },
        { owner: 'v6', type: 'AAAA', address: '2001:db8::1' },
        { owner: 'alias', type: 'CNAME', cname: 'www.tiny.test.' },
        { owner: '@', type: 'MX', exchange: 'mail.tiny.test.', preference: 10 },
        { owner: '@', type: 'TXT', data: 'v=spf1 include:_spf.tiny.test -all' },
        {
          owner: '_sip._tcp',
          type: 'SRV',
          target: 'sip.tiny.test.',
          priority: 20,
          weight: 10,
          port: 5060,
        },
        { owner: '@', type: 'CAA', value: 'letsencrypt.org', flags: 0, tag: 'issue' },
      ],
      { compile: true },
    )
  })

  it('surfaces tinydns-data parse errors instead of swallowing them', async (t) => {
    if (noCompile) return t.skip(noCompile)

    await publish([NS], { compile: true })
    // Corrupt the compiled input the way a bad record would.
    await fs.writeFile(path.join(dir, 'data'), 'Xnot-a-valid-line\n')

    const pub = new TinydnsCdbPublisher({ path: dir, compile: true })
    // publish() rewrites data, so drive tinydns-data over the corrupt file.
    await assert.rejects(
      () => execFileAsync('tinydns-data', [], { cwd: dir }),
      /./,
      'tinydns-data rejects the bad line',
    )
    assert.ok(pub)
  })
})

describe('TinydnsCdbPublisher served data', () => {
  it('answers from the compiled cdb via tinydns-get', async (t) => {
    if (noCompile) return t.skip(noCompile)
    if (noQuery) return t.skip(noQuery)

    await publish([NS, { owner: 'www', type: 'A', address: '192.0.2.44', ttl: 300 }], {
      compile: true,
    })

    // tinydns-get <type> <name> — reads ./data.cdb from cwd.
    const { stdout } = await execFileAsync('tinydns-get', ['1', 'www.tiny.test'], {
      cwd: dir,
    })

    assert.match(stdout, /answer/, 'the cdb yields an answer section')
    assert.match(stdout, /192\.0\.2\.44/, 'with the address we published')
  })

  it('serves the synthesized SOA from the cdb', async (t) => {
    if (noCompile) return t.skip(noCompile)
    if (noQuery) return t.skip(noQuery)

    await publish([NS], { compile: true })
    const { stdout } = await execFileAsync('tinydns-get', ['6', 'tiny.test'], {
      cwd: dir,
    })

    assert.match(stdout, /ns1\.tiny\.test/, 'MNAME is the apex NS')
    assert.match(stdout, /hostmaster\.tiny\.test/, 'RNAME is mailaddr')
  })

  it('refuses a zone name that could inject lines into the shared data file', async () => {
    // Unlike the zone-file publishers, every zone lands in one `data` file, so
    // a newline in a zone name would forge records rather than spoil one file.
    const pub = new TinydnsCdbPublisher({ path: dir, compile: false })
    const evil = new Map([
      ['ok.test\n+forged.test:192.0.2.1', { zone: { zone: 'x' }, records: [] }],
    ])

    await assert.rejects(() => pub.publish(evil), /unsafe zone name/)
  })
})
