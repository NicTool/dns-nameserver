// The signing primitives, checked against the examples RFC 4034 publishes.
// These decide whether a signature verifies anywhere, and a mistake in them is
// invisible until some other implementation refuses the zone.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'

import { keyTag, dnskeyRdata, algorithmName, ALGORITHM_IDS } from '../lib/dnssec-keys.js'
import {
  canonicalName,
  canonicalOrder,
  labelCount,
  nsecRdata,
  rrsigPrefix,
  signRRset,
  sortOwners,
  typeBitmap,
  wireRdataFor,
} from '../lib/dnssec-sign.js'

describe('canonicalName', () => {
  it('encodes a name as uncompressed labels ending in root', () => {
    assert.deepEqual(
      canonicalName('a.example.'),
      Buffer.from('0161076578616d706c6500', 'hex'),
    )
  })

  it('lowercases, because the signature is over the canonical form', () => {
    assert.deepEqual(canonicalName('A.ExAmPlE.'), canonicalName('a.example'))
  })

  it('treats a trailing dot as optional', () => {
    assert.deepEqual(canonicalName('example.com'), canonicalName('example.com.'))
  })

  it('encodes the root as a single zero octet', () => {
    assert.deepEqual(canonicalName('.'), Buffer.from([0]))
  })
})

describe('labelCount', () => {
  // RFC 4034 §3.1.3: the root and a leading wildcard are not counted.
  it('counts the labels of an ordinary name', () => {
    assert.equal(labelCount('www.example.com.'), 3)
    assert.equal(labelCount('example.com'), 2)
  })

  it('does not count a leading wildcard', () => {
    assert.equal(labelCount('*.example.com.'), 2)
  })

  it('counts a literal asterisk that is not the first label', () => {
    assert.equal(labelCount('a.*.example.com.'), 4)
  })
})

describe('canonicalOrder', () => {
  // RFC 4034 §6.3: RDATA is compared as unsigned octets, so a byte over 0x7f
  // sorts high — a signed comparison would order these the other way.
  it('orders rdata as unsigned octets', () => {
    const low = Buffer.from([0x7f, 0, 0, 1])
    const high = Buffer.from([0xc0, 0, 2, 1])
    assert.deepEqual(canonicalOrder([high, low]), [low, high])
  })

  it('orders a shorter prefix before the longer name', () => {
    const short = Buffer.from([1, 2])
    const long = Buffer.from([1, 2, 3])
    assert.deepEqual(canonicalOrder([long, short]), [short, long])
  })

  it('leaves the caller array alone', () => {
    const rdatas = [Buffer.from([2]), Buffer.from([1])]
    canonicalOrder(rdatas)
    assert.deepEqual(rdatas[0], Buffer.from([2]))
  })
})

describe('sortOwners', () => {
  // RFC 4034 §6.1: names sort by label, right to left.
  it('sorts the apex ahead of the names beneath it', () => {
    assert.deepEqual(
      sortOwners(['z.example', 'example', 'a.example', 'yljkjljk.a.example']),
      ['example', 'a.example', 'yljkjljk.a.example', 'z.example'],
    )
  })

  it('compares right to left, not as whole strings', () => {
    // As plain strings 'b.a.example' would sort before 'a.b.example'.
    assert.deepEqual(sortOwners(['b.a.example', 'a.b.example']), [
      'b.a.example',
      'a.b.example',
    ])
  })

  it('ignores case', () => {
    assert.deepEqual(sortOwners(['Z.a.EXAMPLE', 'a.example']), [
      'a.example',
      'Z.a.EXAMPLE',
    ])
  })
})

describe('typeBitmap', () => {
  // RFC 4034 §4.3, the NSEC at alfa.example.com covering A, MX, RRSIG, NSEC
  // and TYPE1234 — the one example with a second window, which is where a
  // hand-rolled bitmap usually goes wrong.
  it('matches the RFC 4034 §4.3 example', () => {
    const expected = Buffer.from(
      '0006400100000003' + '041b' + '00'.repeat(26) + '20',
      'hex',
    )
    assert.deepEqual(typeBitmap([1, 15, 46, 47, 1234]), expected)
  })

  it('sizes a window to its highest type', () => {
    assert.deepEqual(typeBitmap([1]), Buffer.from([0, 1, 0x40]))
  })

  it('emits windows in ascending order', () => {
    const map = typeBitmap([1234, 1])
    assert.equal(map[0], 0, 'window 0 comes first')
  })

  it('collapses a repeated type', () => {
    assert.deepEqual(typeBitmap([1, 1, 1]), typeBitmap([1]))
  })
})

describe('nsecRdata', () => {
  it('is the next owner name followed by the bitmap', () => {
    const rdata = nsecRdata('host.example.com.', [1, 15])
    const name = canonicalName('host.example.com.')
    assert.deepEqual(rdata.subarray(0, name.length), name)
    assert.deepEqual(rdata.subarray(name.length), typeBitmap([1, 15]))
  })
})

describe('keyTag', () => {
  // RFC 4034 Appendix B.1's worked example, whose key id the RFC states.
  it('computes 60485 for the RFC 4034 Appendix B example key', () => {
    const publicKey = Buffer.from(
      'AQOeiiR0GOMYkDshWoSKz9XzfwJr1AYtsmx3TGkJaNXVbfi/2pHm822aJ5iI9BMzNXxeYCmZ' +
        'DRD99WYwYqUSdjMmmAphXdvxegXd/M5+X7OrzKBaMbCVdFLUUh6DhweJBjEVv5f2wwjM9Xzc' +
        'nOf+EPbtG9DMBmADjFDc2w/rljwvFw==',
      'base64',
    )
    const rdata = dnskeyRdata({ flags: 256, protocol: 3, algorithm: 5, publicKey })
    assert.equal(keyTag(rdata), 60485)
  })

  it('stays inside 16 bits', () => {
    const rdata = dnskeyRdata({
      flags: 257,
      protocol: 3,
      algorithm: 13,
      publicKey: Buffer.alloc(64, 0xff),
    })
    assert.ok(keyTag(rdata) >= 0 && keyTag(rdata) <= 0xffff)
  })

  it('changes when the key changes', () => {
    const of = (byte) =>
      keyTag(
        dnskeyRdata({
          flags: 256,
          protocol: 3,
          algorithm: 13,
          publicKey: Buffer.alloc(64, byte),
        }),
      )
    assert.notEqual(of(1), of(2))
  })
})

describe('dnskeyRdata', () => {
  it('is flags, protocol, algorithm, then the key', () => {
    const rdata = dnskeyRdata({
      flags: 257,
      protocol: 3,
      algorithm: 13,
      publicKey: Buffer.from([9, 9]),
    })
    assert.deepEqual(rdata, Buffer.from([0x01, 0x01, 3, 13, 9, 9]))
  })
})

describe('algorithmName', () => {
  it('names the algorithms this can sign with', () => {
    assert.equal(algorithmName(ALGORITHM_IDS.ECDSAP256SHA256), 'ECDSAP256SHA256')
    assert.equal(algorithmName(ALGORITHM_IDS.ED25519), 'ED25519')
  })

  it('falls back to the TYPEnn style for anything else', () => {
    assert.equal(algorithmName(252), 'ALG252')
  })
})

describe('rrsigPrefix', () => {
  const fields = {
    typeCovered: 1,
    algorithm: 13,
    labels: 3,
    originalTtl: 3600,
    expiration: 1_700_000_000,
    inception: 1_699_000_000,
    keyTag: 12345,
    signerName: 'example.com.',
  }

  it('lays the fixed fields out in RFC 4034 §3.1 order', () => {
    const p = rrsigPrefix(fields)
    assert.equal(p.readUInt16BE(0), 1)
    assert.equal(p.readUInt8(2), 13)
    assert.equal(p.readUInt8(3), 3)
    assert.equal(p.readUInt32BE(4), 3600)
    assert.equal(p.readUInt32BE(8), 1_700_000_000)
    assert.equal(p.readUInt32BE(12), 1_699_000_000)
    assert.equal(p.readUInt16BE(16), 12345)
    assert.deepEqual(p.subarray(18), canonicalName('example.com.'))
  })
})

describe('wireRdataFor', () => {
  it('encodes through the resource-record library', () => {
    const rdata = wireRdataFor(
      { type: 'A', address: '192.0.2.1' },
      'www.example.com',
      3600,
    )
    assert.deepEqual(rdata, Buffer.from([192, 0, 2, 1]))
  })

  it('qualifies an owner the rest of the package carries without a dot', () => {
    const bare = wireRdataFor(
      { type: 'NS', dname: 'ns1.example.com.' },
      'example.com',
      3600,
    )
    const dotted = wireRdataFor(
      { type: 'NS', dname: 'ns1.example.com.' },
      'example.com.',
      3600,
    )
    assert.deepEqual(bare, dotted)
  })

  it('throws rather than encoding rdata that does not validate', () => {
    assert.throws(() =>
      wireRdataFor({ type: 'A', address: 'not-an-ip' }, 'a.example', 3600),
    )
  })
})

describe('signRRset', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const key = { algorithm: 13, keyTag: 4242, zone: 'example.com.', privateKey }

  const sign = (rdatas, over = {}) =>
    signRRset({
      owner: 'www.example.com.',
      typeCovered: 1,
      ttl: 3600,
      rdatas,
      key,
      signerName: 'example.com.',
      ...over,
    })

  it('returns the prefix and signature as one rdata', () => {
    const out = sign([Buffer.from([192, 0, 2, 1])])
    const prefixLen = 18 + canonicalName('example.com.').length
    assert.deepEqual(out.rdata.subarray(prefixLen), out.signature)
    assert.equal(out.rdata.readUInt16BE(16), 4242, 'the key tag points back at the key')
  })

  const prefixLen = 18 + canonicalName('example.com.').length

  /** What RFC 4034 §3.1.8.1 says the signature covers, built independently. */
  const signedData = (prefix, rdatas) =>
    Buffer.concat([
      prefix,
      ...rdatas.map((rdata) => {
        const meta = Buffer.alloc(10)
        meta.writeUInt16BE(1, 0)
        meta.writeUInt16BE(1, 2)
        meta.writeUInt32BE(3600, 4)
        meta.writeUInt16BE(rdata.length, 8)
        return Buffer.concat([canonicalName('www.example.com.'), meta, rdata])
      }),
    ])

  const verify = (data, signature) =>
    crypto.verify(
      'sha256',
      data,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    )

  it('produces a signature the matching public key verifies', () => {
    const rdata = Buffer.from([192, 0, 2, 1])
    const out = sign([rdata])
    assert.ok(
      verify(signedData(out.rdata.subarray(0, prefixLen), [rdata]), out.signature),
    )
  })

  // ECDSA signatures are randomized, so two signings of one RRset differ byte
  // for byte. What must hold is that both cover the canonically ordered RRset.
  it('signs the RRset in canonical order, whatever order it arrives in', () => {
    const a = Buffer.from([192, 0, 2, 1])
    const b = Buffer.from([192, 0, 2, 2])
    const window = {
      inception: Date.now() - 3600_000,
      expiration: Date.now() + 86400_000,
    }

    const forwards = sign([a, b], window)
    const backwards = sign([b, a], window)

    const canonical = signedData(forwards.rdata.subarray(0, prefixLen), [a, b])
    assert.ok(verify(canonical, forwards.signature), 'given in order')
    assert.ok(verify(canonical, backwards.signature), 'given reversed')
  })

  it('does not verify against the RRset in the wrong order', () => {
    const a = Buffer.from([192, 0, 2, 1])
    const b = Buffer.from([192, 0, 2, 2])
    const out = sign([a, b])
    const reversed = signedData(out.rdata.subarray(0, prefixLen), [b, a])
    assert.equal(verify(reversed, out.signature), false)
  })

  it('reports its validity window in seconds', () => {
    const out = sign([Buffer.from([192, 0, 2, 1])], {
      inception: new Date('2026-01-01T00:00:00Z'),
      expiration: new Date('2026-02-01T00:00:00Z'),
    })
    assert.equal(out.inception, 1767225600)
    assert.equal(out.expiration, 1769904000)
    assert.equal(out.rdata.readUInt32BE(8), out.expiration)
    assert.equal(out.rdata.readUInt32BE(12), out.inception)
  })
})
