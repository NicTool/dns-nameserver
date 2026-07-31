// TSIG (RFC 8945).
//
// A sign/verify round trip against our own code proves very little — both
// halves could share a mistake. So the digest input is also asserted byte for
// byte against a buffer built here from the RFC's field list, which is where
// implementations actually go wrong: field order, the canonical lowercasing,
// the 48-bit time, and whether ARCOUNT counts the TSIG itself.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'

import { encodeName, encodeNotify } from '../lib/notify.js'
import { extractTsig, parseKey, signMessage, verifyMessage } from '../lib/tsig.js'

const SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaao='
const KEY = { name: 'nictool-key', secret: SECRET, algorithm: 'hmac-sha256' }

const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

describe('parseKey', () => {
  it("reads dig's name:secret form and defaults to sha256", () => {
    const k = parseKey(`nictool-key:${SECRET}`)
    assert.equal(k.name, 'nictool-key')
    assert.equal(k.algorithm, 'hmac-sha256')
  })

  it("reads dig's algorithm:name:secret form", () => {
    const k = parseKey(`hmac-sha512:k2:${SECRET}`)
    assert.equal(k.algorithm, 'hmac-sha512')
    assert.equal(k.name, 'k2')
  })

  it('canonicalizes the key name, which the MAC covers', () => {
    assert.equal(
      parseKey({ name: 'Key.Example.COM.', secret: SECRET }).name,
      'key.example.com',
    )
  })

  it('accepts hmac-md5 by either spelling', () => {
    for (const a of ['hmac-md5', 'hmac-md5.sig-alg.reg.int.']) {
      assert.equal(
        parseKey({ name: 'k', secret: SECRET, algorithm: a }).algorithm,
        'hmac-md5.sig-alg.reg.int',
      )
    }
  })

  it('rejects an unknown algorithm', () => {
    assert.throws(
      () => parseKey({ name: 'k', secret: SECRET, algorithm: 'hmac-sha3' }),
      /unsupported algorithm/,
    )
  })

  it('rejects a secret that is not base64, which would silently mis-MAC', () => {
    assert.throws(() => parseKey({ name: 'k', secret: '!!!!' }), /not valid base64/)
  })

  it('requires both halves', () => {
    assert.throws(() => parseKey({ secret: SECRET }), /key name is required/)
    assert.throws(() => parseKey({ name: 'k' }), /key secret is required/)
    assert.throws(() => parseKey('just-a-name'), /expected/)
  })
})

describe('signMessage', () => {
  const message = encodeNotify({ id: 0x1234, zone: 'example.com' })

  it('digests exactly the fields RFC 8945 lists, in order', () => {
    const timeSigned = 1700000000
    const fudge = 300
    const { mac } = signMessage({ message, key: KEY, timeSigned, fudge })

    // §4.3.3 signed variables, assembled independently of the implementation.
    const variables = Buffer.concat([
      encodeName('nictool-key'),
      u16(255), // CLASS ANY
      Buffer.alloc(4), // TTL 0
      encodeName('hmac-sha256'),
      // 48-bit time signed, derived via hex rather than writeUIntBE so this is
      // not just restating what the implementation does.
      Buffer.from(`0000${timeSigned.toString(16).padStart(8, '0')}`, 'hex'),
      u16(fudge),
      u16(0), // Error
      u16(0), // Other Len
    ])
    // §5.3.1: the request digest is the message as it stood, then the variables.
    const expected = crypto
      .createHmac('sha256', Buffer.from(SECRET, 'base64'))
      .update(message)
      .update(variables)
      .digest()

    assert.deepEqual(mac, expected)
  })

  it('writes a 48-bit time signed', () => {
    const timeSigned = 1700000000
    const { message: signed } = signMessage({ message, key: KEY, timeSigned })
    const { tsig } = extractTsig(signed)
    assert.equal(tsig.timeSigned, timeSigned)
  })

  it('appends the TSIG as the last record and bumps ARCOUNT', () => {
    const { message: signed } = signMessage({ message, key: KEY })

    assert.equal(signed.readUInt16BE(10), 1, 'ARCOUNT now counts the TSIG')
    assert.equal(message.readUInt16BE(10), 0, 'the original is untouched')

    const { tsig, stripped } = extractTsig(signed)
    assert.equal(tsig.name, 'nictool-key')
    assert.equal(tsig.algorithm, 'hmac-sha256')
    assert.equal(tsig.mac.length, 32)
    assert.equal(tsig.originalId, 0x1234)
    assert.equal(tsig.error, 0)
    // What was hashed is the message as it was before signing.
    assert.deepEqual(stripped, message)
  })

  it('gives the TSIG RR a zero TTL and class ANY', () => {
    const { message: signed } = signMessage({ message, key: KEY })
    const nameLen = encodeName('nictool-key').length
    const rrStart = signed.length - findRrLength(signed, nameLen)
    assert.equal(signed.readUInt16BE(rrStart + nameLen), 250, 'TYPE TSIG')
    assert.equal(signed.readUInt16BE(rrStart + nameLen + 2), 255, 'CLASS ANY')
    assert.equal(signed.readUInt32BE(rrStart + nameLen + 4), 0, 'TTL 0')
  })

  it('produces a different MAC for a different zone', () => {
    const a = signMessage({ message, key: KEY, timeSigned: 1 }).mac
    const b = signMessage({
      message: encodeNotify({ id: 0x1234, zone: 'other.example' }),
      key: KEY,
      timeSigned: 1,
    }).mac
    assert.notDeepEqual(a, b)
  })

  it('produces a different MAC under a different key name', () => {
    const a = signMessage({ message, key: KEY, timeSigned: 1 }).mac
    const b = signMessage({
      message,
      key: { ...KEY, name: 'other-key' },
      timeSigned: 1,
    }).mac
    assert.notDeepEqual(a, b, 'the key name is part of the signed variables')
  })
})

function findRrLength(signed, nameLen) {
  // rdlength sits 8 bytes past the end of the owner name.
  for (let start = 12; start < signed.length; start++) {
    if (signed.readUInt16BE(start + nameLen) === 250) {
      const rdlength = signed.readUInt16BE(start + nameLen + 8)
      if (start + nameLen + 10 + rdlength === signed.length) return signed.length - start
    }
  }
  throw new Error('TSIG RR not found')
}

describe('verifyMessage', () => {
  const request = encodeNotify({ id: 0x2222, zone: 'example.com' })

  /** What a compliant secondary sends back: QR set, signed over our MAC. */
  function reply({ key = KEY, requestMac, rcode = 0, timeSigned, id = 0x2222 }) {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(id, 0)
    header.writeUInt16BE(0x8000 | (4 << 11) | rcode, 2)
    return signMessage({ message: header, key, requestMac, timeSigned }).message
  }

  it('accepts a reply signed over the request MAC', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    const res = verifyMessage({
      message: reply({ requestMac: mac }),
      key: KEY,
      requestMac: mac,
    })
    assert.equal(res.ok, true, res.error)
  })

  it('rejects a reply that omitted the request MAC', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    // Signed, but without chaining to our request — a replayed acknowledgement.
    const res = verifyMessage({
      message: reply({ requestMac: null }),
      key: KEY,
      requestMac: mac,
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /MAC mismatch/)
  })

  it('rejects a reply signed with the wrong secret', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    const other = { ...KEY, secret: Buffer.alloc(32, 7).toString('base64') }
    const res = verifyMessage({
      message: reply({ key: other, requestMac: mac }),
      key: KEY,
      requestMac: mac,
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /MAC mismatch/)
  })

  it('rejects an unknown key name', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    const res = verifyMessage({
      message: reply({ key: { ...KEY, name: 'nope' }, requestMac: mac }),
      key: KEY,
      requestMac: mac,
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /key mismatch/)
  })

  it('rejects a signature outside the fudge window', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    const long_ago = Math.floor(Date.now() / 1000) - 4000
    const res = verifyMessage({
      message: reply({ requestMac: mac, timeSigned: long_ago }),
      key: KEY,
      requestMac: mac,
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /outside the fudge|outside fudge/)
  })

  it('reports an unsigned message rather than passing it', () => {
    const res = verifyMessage({ message: request, key: KEY })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'no TSIG')
  })

  it('rejects a flipped bit anywhere in the body', () => {
    const { mac } = signMessage({ message: request, key: KEY })
    const signed = reply({ requestMac: mac })
    signed[2] ^= 0x01 // header flags
    const res = verifyMessage({ message: signed, key: KEY, requestMac: mac })
    assert.equal(res.ok, false)
  })

  it('round-trips every supported algorithm', () => {
    for (const algorithm of [
      'hmac-md5',
      'hmac-sha1',
      'hmac-sha224',
      'hmac-sha256',
      'hmac-sha384',
      'hmac-sha512',
    ]) {
      const key = { name: 'k', secret: SECRET, algorithm }
      const { mac } = signMessage({ message: request, key })
      const res = verifyMessage({
        message: reply({ key, requestMac: mac }),
        key,
        requestMac: mac,
      })
      assert.equal(res.ok, true, `${algorithm}: ${res.error}`)
    }
  })
})

describe('extractTsig', () => {
  it('returns null when there is no additional section', () => {
    assert.equal(extractTsig(encodeNotify({ id: 1, zone: 'a.com' })), null)
  })

  it('refuses a TSIG that is not the final record', () => {
    const { message } = signMessage({
      message: encodeNotify({ id: 1, zone: 'a.com' }),
      key: KEY,
    })
    const trailing = Buffer.concat([message, Buffer.from([0, 0, 1])])
    assert.throws(() => extractTsig(trailing), /not the last thing/)
  })

  it('rejects a short message', () => {
    assert.throws(() => extractTsig(Buffer.alloc(6)), /short DNS message/)
  })
})
