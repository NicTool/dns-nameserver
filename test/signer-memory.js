// MemorySigner signs the live zone map itself, so these tests generate their
// own BIND-format keyset with node's crypto rather than shelling out to
// dnssec-keygen — the signing is what is under test, not the tooling, and the
// suite should not skip where BIND is absent.
//
// The signature check rebuilds RFC 4034 §3.1.8.1's signed data by hand instead
// of calling dnssec-sign.js. Verifying with the same code that signed would
// only prove the code agrees with itself.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { keyTag, dnskeyRdata } from '../lib/dnssec-keys.js'
import MemorySigner from '../lib/signer/memory.js'

const APEX = 'signer.test'
const ECDSAP256 = 13

let keyDir
let zsk
let ksk

/** A K<zone>.+013+<tag>.{key,private} pair, in the format BIND writes. */
async function writeKeyPair(dir, zone, flags) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const jwk = privateKey.export({ format: 'jwk' })
  const b64 = (v) => Buffer.from(v, 'base64url')
  const raw = Buffer.concat([b64(jwk.x), b64(jwk.y)])
  const rdata = dnskeyRdata({ flags, protocol: 3, algorithm: ECDSAP256, publicKey: raw })
  const tag = keyTag(rdata)
  const base = path.join(dir, `K${zone}.+0${ECDSAP256}+${String(tag).padStart(5, '0')}`)

  await fs.writeFile(
    `${base}.key`,
    `; test key\n${zone}. IN DNSKEY ${flags} 3 ${ECDSAP256} ${raw.toString('base64')}\n`,
  )
  await fs.writeFile(
    `${base}.private`,
    `Private-key-format: v1.3\nAlgorithm: ${ECDSAP256} (ECDSAP256SHA256)\n` +
      `PrivateKey: ${b64(jwk.d).toString('base64')}\n`,
  )
  return { tag, publicKey, raw, flags }
}

function canonicalName(name) {
  const parts = []
  for (const label of String(name).toLowerCase().replace(/\.$/, '').split('.')) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, 'utf8'))
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

const zoneRow = {
  zone: APEX,
  ttl: 3600,
  serial: 2026072801,
  refresh: 86400,
  retry: 7200,
  expire: 1209600,
  minimum: 3600,
  nsname: `ns1.${APEX}.`,
  mailaddr: `hostmaster.${APEX}.`,
}

const baseRecords = () => [
  { type: 'NS', owner: APEX, ttl: 3600, dname: `ns1.${APEX}.` },
  { type: 'A', owner: `ns1.${APEX}`, ttl: 3600, address: '192.0.2.53' },
  { type: 'A', owner: `www.${APEX}`, ttl: 3600, address: '192.0.2.1' },
  { type: 'A', owner: `www.${APEX}`, ttl: 3600, address: '192.0.2.2' },
  { type: 'AAAA', owner: `www.${APEX}`, ttl: 3600, address: '2001:db8::1' },
]

const makePublisher = (records = baseRecords()) => ({
  zones: new Map([[APEX, { zone: { ...zoneRow }, records }]]),
})

async function signWith(publisher, opts = {}) {
  const signer = new MemorySigner({ keyset: keyDir, ...opts })
  signer.attach(publisher)
  signer.on('error', () => {})
  const artifacts = await signer.sign({ kind: 'memory' })
  return { signer, artifacts, records: publisher.zones.get(APEX).records }
}

const byType = (records, type) => records.filter((r) => r.type === type)

before(async () => {
  keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memsigner-'))
  zsk = await writeKeyPair(keyDir, APEX, 256)
  ksk = await writeKeyPair(keyDir, APEX, 257)
})

after(async () => {
  await fs.rm(keyDir, { recursive: true, force: true })
})

describe('MemorySigner', () => {
  it('reports what it signed', async () => {
    const { artifacts } = await signWith(makePublisher())
    assert.equal(artifacts.dnssec.signed, 1)
    assert.equal(artifacts.dnssec.nsec3, false)
    assert.ok(artifacts.dnssec.signatures > 0)
    assert.equal(artifacts.kind, 'memory', 'passes the other artifacts through')
  })

  it('publishes both DNSKEYs at the apex', async () => {
    const { records } = await signWith(makePublisher())
    const keys = byType(records, 'DNSKEY')
    assert.equal(keys.length, 2)
    assert.deepEqual(
      keys.map((k) => k.flags).sort(),
      [256, 257],
      'a zone-signing key and a key-signing key',
    )
    for (const key of keys) assert.equal(key.owner, APEX)
  })

  it('keeps the original records alongside the signatures', async () => {
    const { records } = await signWith(makePublisher())
    assert.equal(byType(records, 'A').length, 3)
    assert.equal(byType(records, 'AAAA').length, 1)
    assert.equal(byType(records, 'NS').length, 1)
  })

  it('signs every RRset, including the SOA it synthesizes', async () => {
    const { records } = await signWith(makePublisher())
    const covered = new Set(byType(records, 'RRSIG').map((r) => r.typeCovered))
    // A(1) NS(2) SOA(6) AAAA(28) NSEC(47) DNSKEY(48)
    for (const type of [1, 2, 6, 28, 47, 48]) {
      assert.ok(covered.has(type), `RRSIG covering type ${type}`)
    }
  })

  // RFC 4035 §2.2: the DNSKEY RRset is signed by the key-signing key, so a
  // validator with only the DS can reach the rest of the zone.
  it('signs the DNSKEY RRset with the KSK and everything else with the ZSK', async () => {
    const { records } = await signWith(makePublisher())
    const tagOf = (rdata) => Buffer.from(rdata).readUInt16BE(16)

    for (const sig of byType(records, 'RRSIG')) {
      const expected = sig.typeCovered === 48 ? ksk.tag : zsk.tag
      assert.equal(tagOf(sig.wireRdata), expected, `type ${sig.typeCovered}`)
    }
  })

  it('produces a signature the public key verifies', async () => {
    const { records } = await signWith(makePublisher())
    const sig = byType(records, 'RRSIG').find(
      (r) => r.typeCovered === 1 && r.owner === `ns1.${APEX}`,
    )
    assert.ok(sig, 'an RRSIG over the single-record A RRset')

    const rdata = Buffer.from(sig.wireRdata)
    const signerName = canonicalName(APEX)
    const prefixLen = 18 + signerName.length
    const prefix = rdata.subarray(0, prefixLen)
    const signature = rdata.subarray(prefixLen)

    // RFC 4034 §3.1.8.1: RRSIG_RDATA | owner | type | class | orig TTL | len | rdata
    const meta = Buffer.alloc(10)
    meta.writeUInt16BE(1, 0) // A
    meta.writeUInt16BE(1, 2) // IN
    meta.writeUInt32BE(3600, 4)
    meta.writeUInt16BE(4, 8)
    const rr = Buffer.concat([
      canonicalName(`ns1.${APEX}`),
      meta,
      Buffer.from([192, 0, 2, 53]),
    ])

    assert.ok(
      crypto.verify(
        'sha256',
        Buffer.concat([prefix, rr]),
        { key: zsk.publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
      'RRSIG verifies against the zone-signing key',
    )
  })

  it('records the signer name and label count the RRSIG claims', async () => {
    const { records } = await signWith(makePublisher())
    const sig = byType(records, 'RRSIG').find(
      (r) => r.typeCovered === 1 && r.owner === `www.${APEX}`,
    )
    const rdata = Buffer.from(sig.wireRdata)
    assert.equal(rdata.readUInt8(3), 3, 'www.signer.test is three labels')
    assert.equal(rdata.readUInt32BE(4), 3600, 'original TTL')
    assert.ok(rdata.readUInt32BE(8) > rdata.readUInt32BE(12), 'expires after inception')
    assert.ok(
      rdata
        .subarray(18)
        .subarray(0, canonicalName(APEX).length)
        .equals(canonicalName(APEX)),
      'signer name is the apex',
    )
  })

  // RFC 4034 §4: the chain visits every name in canonical order and closes on
  // the apex, so a gap between two links is a name the zone can deny.
  it('chains NSEC through every name and wraps at the apex', async () => {
    const { records } = await signWith(makePublisher())
    const nsec = byType(records, 'NSEC')
    const next = new Map(nsec.map((r) => [r.owner, r.next]))

    assert.deepEqual(
      [...next.keys()].sort(),
      [`ns1.${APEX}`, APEX, `www.${APEX}`].sort(),
      'every name that exists is on the chain',
    )

    const walked = []
    let at = APEX
    do {
      walked.push(at)
      at = next.get(at)
    } while (at !== APEX && walked.length <= next.size)

    assert.deepEqual(walked, [APEX, `ns1.${APEX}`, `www.${APEX}`], 'canonical order')
    assert.equal(at, APEX, 'the last name points back at the apex')
  })

  it("lists NSEC and RRSIG in each name's own bitmap", async () => {
    const { records } = await signWith(makePublisher())
    for (const rec of byType(records, 'NSEC')) {
      assert.ok(rec.types.includes(47), `NSEC at ${rec.owner}`)
      assert.ok(rec.types.includes(46), `RRSIG at ${rec.owner}`)
    }
  })

  // A second publish cycle re-signs the zone as published. Signing the previous
  // signatures too would grow the zone without bound and leave stale RRSIGs
  // that no longer match their RRset.
  it('re-signs rather than stacking signatures', async () => {
    const publisher = makePublisher()
    const first = await signWith(publisher)
    const firstCount = first.records.length
    const firstSigs = first.artifacts.dnssec.signatures

    const second = await signWith(publisher)
    assert.equal(second.records.length, firstCount)
    assert.equal(second.artifacts.dnssec.signatures, firstSigs)
  })

  it('does nothing when the publisher holds no zones', async () => {
    const artifacts = { kind: 'memory' }
    const signer = new MemorySigner({ keyset: keyDir })
    signer.attach({ zones: new Map() })
    assert.strictEqual(await signer.sign(artifacts), artifacts)
  })

  it('refuses NSEC3 rather than quietly publishing an NSEC chain', async () => {
    const signer = new MemorySigner({ keyset: keyDir, nsec3: true })
    signer.attach(makePublisher())
    await assert.rejects(() => signer.sign({}), /NSEC3 is not implemented/)
  })

  it('names the keyset when a zone has no keys', async () => {
    const signer = new MemorySigner({ keyset: path.join(keyDir, 'empty') })
    signer.attach(makePublisher())
    await assert.rejects(() => signer.sign({}), /no usable keys for signer\.test/)
  })

  // Skipping a record would serve it unsigned inside an otherwise signed zone,
  // which a validator reads as an attack rather than as a NicTool bug.
  it('fails the zone when a record cannot be encoded', async () => {
    const records = [
      ...baseRecords(),
      { type: 'A', owner: `bad.${APEX}`, address: 'nope' },
    ]
    const signer = new MemorySigner({ keyset: keyDir })
    signer.attach(makePublisher(records))
    await assert.rejects(() => signer.sign({}), /cannot encode bad\.signer\.test A/)
  })
})
