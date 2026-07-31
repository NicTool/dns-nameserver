// DNSSEC is delegated to each nameserver's own tooling, so these tests run the real
// dnssec-keygen and dnssec-signzone when they are installed, and skip otherwise.
// Asserting against a mocked signer would only confirm the arguments we chose.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import { promisify } from 'node:util'

import {
  ALGORITHMS,
  DNSSEC_STRATEGY,
  assertAlgorithm,
  existingKeys,
  ensureKeys,
  signZoneFile,
  strategyFor,
} from '../lib/dnssec.js'
import Rfc1035Signer from '../lib/signer/rfc1035.js'

const execFileAsync = promisify(execFile)

let haveTools = false
before(async () => {
  try {
    await execFileAsync('dnssec-keygen', ['-h'])
    haveTools = true
  } catch {
    // -h exits non-zero on some builds; a missing binary is ENOENT.
    haveTools = await which('dnssec-signzone')
  }
})

async function which(bin) {
  try {
    await execFileAsync('command', ['-v', bin], { shell: '/bin/sh' })
    return true
  } catch {
    return false
  }
}

let dir
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-dnssec-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ZONE = 'sec.example'

async function writeZone(name = ZONE) {
  const file = path.join(dir, `${name}.zone`)
  await fs.writeFile(
    file,
    [
      `$ORIGIN ${name}.`,
      '$TTL 300',
      `@\t300\tIN\tSOA\tns1.${name}. hostmaster.${name}. 5 86400 7200 1209600 3600`,
      `@\t300\tIN\tNS\tns1.${name}.`,
      `ns1\t300\tIN\tA\t192.0.2.53`,
      `www\t300\tIN\tA\t192.0.2.2`,
      '',
    ].join('\n'),
  )
  return file
}

describe('which nameserver signs how', () => {
  it('sends bind, nsd and coredns through a signer here', () => {
    for (const type of ['bind', 'nsd', 'coredns']) {
      assert.equal(strategyFor(type), 'signer', type)
    }
  })

  it('leaves knot and powerdns to sign for themselves', () => {
    // Both manage their own keys; NicTool only declares the policy.
    assert.equal(strategyFor('knot'), 'self')
    assert.equal(strategyFor('powerdns'), 'self')
  })

  it('signs in process for native, which has no external tool', () => {
    assert.equal(strategyFor('native'), 'memory')
  })

  it('has nothing for types with no DNSSEC support', () => {
    for (const type of ['djbdns', 'maradns']) {
      assert.equal(strategyFor(type), 'none', type)
    }
  })

  it('covers every type the supervisor can build', () => {
    const types = [
      'native',
      'bind',
      'knot',
      'nsd',
      'coredns',
      'powerdns',
      'djbdns',
      'maradns',
    ]
    for (const t of types) assert.ok(DNSSEC_STRATEGY[t], `no strategy for ${t}`)
  })

  it('treats an unknown type as unsupported rather than guessing', () => {
    assert.equal(strategyFor('nonesuch'), 'none')
  })
})

describe('assertAlgorithm', () => {
  it('accepts every algorithm the API schema offers', () => {
    for (const a of ALGORITHMS) assert.equal(assertAlgorithm(a), a)
  })

  it('defaults rather than failing on an empty value', () => {
    assert.equal(assertAlgorithm(undefined), 'ECDSAP256SHA256')
  })

  it('rejects one dnssec-keygen would not understand', () => {
    assert.throws(() => assertAlgorithm('ROT13'), /unsupported algorithm/)
  })
})

describe('key management', () => {
  it('generates a KSK and a ZSK for a new zone', async (t) => {
    if (!haveTools) return t.skip('dnssec-keygen not installed')
    const keyDir = path.join(dir, 'keys')

    const first = await ensureKeys({ keyDir, zone: ZONE })
    assert.equal(first.created.length, 2, 'one ZSK and one KSK')

    const keys = await existingKeys(keyDir, ZONE)
    assert.equal(keys.length, 2)
  })

  it('leaves existing keys alone, because rolling them is not a publish', async (t) => {
    if (!haveTools) return t.skip('dnssec-keygen not installed')
    const keyDir = path.join(dir, 'keys')

    await ensureKeys({ keyDir, zone: ZONE })
    const before = await existingKeys(keyDir, ZONE)

    const second = await ensureKeys({ keyDir, zone: ZONE })
    assert.equal(second.created.length, 0)
    assert.deepEqual(await existingKeys(keyDir, ZONE), before)
  })

  it("keeps one zone's keys out of another's", async (t) => {
    if (!haveTools) return t.skip('dnssec-keygen not installed')
    const keyDir = path.join(dir, 'keys')
    await ensureKeys({ keyDir, zone: 'a.example' })
    await ensureKeys({ keyDir, zone: 'b.example' })

    assert.equal((await existingKeys(keyDir, 'a.example')).length, 2)
    assert.equal((await existingKeys(keyDir, 'b.example')).length, 2)
  })

  it('reports a missing tool as a missing tool', async () => {
    await assert.rejects(
      () =>
        ensureKeys({
          keyDir: path.join(dir, 'keys'),
          zone: ZONE,
          keygen: 'definitely-not-a-real-binary',
        }),
      /not found/,
    )
  })
})

describe('signZoneFile', () => {
  it('signs over the same path, so the generated config stays correct', async (t) => {
    if (!haveTools) return t.skip('dnssec-signzone not installed')
    const keyDir = path.join(dir, 'keys')
    const file = await writeZone()
    await ensureKeys({ keyDir, zone: ZONE })

    const unsigned = await fs.readFile(file, 'utf8')
    assert.equal(unsigned.includes('RRSIG'), false)

    await signZoneFile({ zone: ZONE, file, keyDir })

    const signed = await fs.readFile(file, 'utf8')
    assert.match(signed, /RRSIG/)
    assert.match(signed, /DNSKEY/)
    // The name the config referenced is still the name of a real file.
    assert.equal(path.basename(file), `${ZONE}.zone`)
  })

  it('produces NSEC3 when asked, NSEC otherwise', async (t) => {
    if (!haveTools) return t.skip('dnssec-signzone not installed')
    const keyDir = path.join(dir, 'keys')
    await ensureKeys({ keyDir, zone: ZONE })

    const plain = await writeZone()
    await signZoneFile({ zone: ZONE, file: plain, keyDir })
    const nsec = await fs.readFile(plain, 'utf8')
    assert.match(nsec, /\bNSEC\b/)
    assert.doesNotMatch(nsec, /\bNSEC3\b/)

    const three = await writeZone('n3.example')
    await ensureKeys({ keyDir, zone: 'n3.example' })
    await signZoneFile({ zone: 'n3.example', file: three, keyDir, nsec3: true })
    assert.match(await fs.readFile(three, 'utf8'), /NSEC3/)
  })

  it('surfaces what dnssec-signzone complained about', async (t) => {
    if (!haveTools) return t.skip('dnssec-signzone not installed')
    const keyDir = path.join(dir, 'keys')
    const file = path.join(dir, 'broken.zone')
    await fs.writeFile(file, 'this is not a zone file\n')
    await ensureKeys({ keyDir, zone: 'broken.example' })

    await assert.rejects(
      () => signZoneFile({ zone: 'broken.example', file, keyDir }),
      /failed to sign broken.example/,
    )
  })
})

describe('Rfc1035Signer', () => {
  it('signs each zone file and leaves the server config alone', async (t) => {
    if (!haveTools) return t.skip('dnssec-signzone not installed')
    const keyset = path.join(dir, 'keys')
    const zoneFile = await writeZone()
    const configFile = path.join(dir, 'named.conf')
    await fs.writeFile(configFile, 'zone "sec.example" { type master; };\n')

    const signer = new Rfc1035Signer({ keyset })
    const out = await signer.sign({
      kind: 'rfc1035',
      directory: dir,
      files: [{ zone: ZONE, path: zoneFile }, { path: configFile }],
      config: configFile,
    })

    assert.equal(out.dnssec.signed, 1)
    assert.equal(out.dnssec.keysCreated, 2)
    assert.match(await fs.readFile(zoneFile, 'utf8'), /RRSIG/)
    // A config entry has no zone, so it must not be handed to the signer.
    assert.equal(
      await fs.readFile(configFile, 'utf8'),
      'zone "sec.example" { type master; };\n',
    )
  })

  it('passes artifacts through untouched when there are no zones', async () => {
    const signer = new Rfc1035Signer({ keyset: path.join(dir, 'keys') })
    const artifacts = { kind: 'rfc1035', files: [{ path: '/x/named.conf' }] }
    assert.equal(await signer.sign(artifacts), artifacts)
  })

  it('generates keys once across repeated publishes', async (t) => {
    if (!haveTools) return t.skip('dnssec-signzone not installed')
    const keyset = path.join(dir, 'keys')
    const signer = new Rfc1035Signer({ keyset })

    const first = await signer.sign({
      files: [{ zone: ZONE, path: await writeZone() }],
    })
    assert.equal(first.dnssec.keysCreated, 2)

    // A second cycle re-renders the zone and signs it again with the same keys.
    const second = await signer.sign({
      files: [{ zone: ZONE, path: await writeZone() }],
    })
    assert.equal(second.dnssec.keysCreated, 0, 'keys are not rolled on every publish')
    assert.equal(second.dnssec.signed, 1)
  })
})
