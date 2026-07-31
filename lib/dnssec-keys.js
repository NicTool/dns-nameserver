import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * BIND-format DNSSEC key files, loaded into something node's crypto can sign
 * with.
 *
 * The same K<zone>.+<alg>+<tag>.{key,private} pair dnssec-keygen writes and
 * dnssec-signzone reads, so a zone can move between the in-process signer and
 * the file signer without re-keying, and an operator can use the tools they
 * already know for rollover.
 *
 * The .private file holds raw key material, not PKCS#8: for ECDSA it is the
 * private scalar, for EdDSA the seed. The public half comes from the .key
 * file's DNSKEY rdata, which is x||y for ECDSA and the raw point for EdDSA.
 */

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** RFC 8624 / RFC 4034 §A.1, restricted to what node can actually sign with. */
export const ALGORITHM_IDS = {
  RSASHA256: 8,
  RSASHA512: 10,
  ECDSAP256SHA256: 13,
  ECDSAP384SHA384: 14,
  ED25519: 15,
  ED448: 16,
}

const BY_ID = Object.fromEntries(Object.entries(ALGORITHM_IDS).map(([k, v]) => [v, k]))

const CURVES = {
  13: { crv: 'P-256', size: 32, hash: 'sha256' },
  14: { crv: 'P-384', size: 48, hash: 'sha384' },
}

const EDWARDS = {
  15: { crv: 'Ed25519', size: 32 },
  16: { crv: 'Ed448', size: 57 },
}

export const algorithmName = (id) => BY_ID[id] ?? `ALG${id}`

/**
 * RFC 4034 Appendix B. Not a checksum of the file — the tag is computed from
 * the DNSKEY rdata, and it is what an RRSIG points back to.
 */
export function keyTag(rdata) {
  const bytes = Uint8Array.from(rdata)
  let total = 0
  for (let i = 0; i < bytes.length; i++) {
    total += i & 1 ? bytes[i] : bytes[i] << 8
  }
  total += (total >> 16) & 0xffff
  return total & 0xffff
}

/** DNSKEY rdata: flags(2) protocol(1) algorithm(1) publickey. */
export function dnskeyRdata({ flags, protocol = 3, algorithm, publicKey }) {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(flags, 0)
  head.writeUInt8(protocol, 2)
  head.writeUInt8(algorithm, 3)
  return Buffer.concat([head, Buffer.from(publicKey)])
}

function parsePrivate(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

/** The DNSKEY line in a .key file, ignoring its comment header. */
function parsePublic(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    const m = line.match(/\bDNSKEY\s+(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/i)
    if (!m) continue
    return {
      flags: Number(m[1]),
      protocol: Number(m[2]),
      algorithm: Number(m[3]),
      publicKey: Buffer.from(m[4].replace(/\s+/g, ''), 'base64'),
    }
  }
  throw new Error('no DNSKEY record in key file')
}

/**
 * Rebuild a signing key from the raw material BIND stores.
 *
 * RSA is deliberately absent: its .private file holds the CRT parameters as
 * separate base64 fields, and assembling a PKCS#8 from them is a lot of ASN.1
 * for an algorithm RFC 8624 already rates as only "MAY" for signing. The
 * elliptic curves cover what anyone should be deploying now.
 */
function toPrivateKey({ algorithm, priv, publicKey }) {
  const material = Buffer.from(priv.PrivateKey ?? '', 'base64')
  if (!material.length) throw new Error('PrivateKey field is missing or not base64')

  const ec = CURVES[algorithm]
  if (ec) {
    if (publicKey.length !== ec.size * 2) {
      throw new Error(`public key is ${publicKey.length} bytes, expected ${ec.size * 2}`)
    }
    return crypto.createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: ec.crv,
        d: b64u(material),
        x: b64u(publicKey.subarray(0, ec.size)),
        y: b64u(publicKey.subarray(ec.size)),
      },
    })
  }

  const ed = EDWARDS[algorithm]
  if (ed) {
    return crypto.createPrivateKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: ed.crv, d: b64u(material), x: b64u(publicKey) },
    })
  }

  throw new Error(
    `algorithm ${algorithmName(algorithm)} cannot be signed with in-process; ` +
      `use an elliptic curve, or an engine that signs for itself`,
  )
}

/** Sign with the shape DNSSEC expects — r||s for ECDSA, not DER. */
export function signWith(key, data) {
  if (EDWARDS[key.algorithm]) return crypto.sign(null, data, key.privateKey)
  const ec = CURVES[key.algorithm]
  return crypto.sign(ec.hash, data, {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
}

/**
 * Every usable key for a zone, newest ignored — DNSSEC picks by flags, not by
 * date. A key whose material this cannot load is reported rather than dropped,
 * so a half-supported keyset does not silently sign with fewer keys than the
 * operator thinks.
 */
export async function loadKeys(keyDir, zone) {
  let entries
  try {
    entries = await fs.readdir(keyDir)
  } catch (err) {
    if (err.code === 'ENOENT') return { keys: [], errors: [] }
    throw err
  }

  const prefix = `K${zone}.+`
  const keys = []
  const errors = []

  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.key')) continue
    const base = name.slice(0, -4)
    try {
      const pub = parsePublic(await fs.readFile(path.join(keyDir, name), 'utf8'))
      const priv = parsePrivate(
        await fs.readFile(path.join(keyDir, `${base}.private`), 'utf8'),
      )
      const rdata = dnskeyRdata({ ...pub, publicKey: pub.publicKey })
      keys.push({
        zone,
        flags: pub.flags,
        protocol: pub.protocol,
        algorithm: pub.algorithm,
        publicKey: pub.publicKey,
        rdata,
        keyTag: keyTag(rdata),
        // Bit 0 of the flags field: a key-signing key signs the DNSKEY RRset.
        isKsk: (pub.flags & 0x0001) === 1,
        privateKey: toPrivateKey({
          algorithm: pub.algorithm,
          priv,
          publicKey: pub.publicKey,
        }),
      })
    } catch (err) {
      errors.push({ file: name, message: err.message })
    }
  }

  return { keys, errors }
}

export default { loadKeys, keyTag, dnskeyRdata, signWith, algorithmName, ALGORITHM_IDS }
