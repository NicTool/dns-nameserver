import crypto from 'node:crypto'

import { encodeName } from './notify.js'

/**
 * TSIG — secret key transaction authentication for DNS (RFC 8945).
 *
 * Signs an outbound message and verifies the reply. Only what NicTool sends
 * needs signing today (NOTIFY), but verification is here too: a server that
 * requires TSIG signs its response, and accepting that unchecked would defeat
 * the point of signing the request.
 *
 * RFC 8945 §10 deprecates HMAC-MD5 and SHA-1; both are accepted for talking to
 * old peers, and the default is SHA-256, which §10 requires implementations to
 * support.
 */

const TYPE_TSIG = 250
const CLASS_ANY = 255

// RFC 8945 §2 registry. The name goes on the wire, so it is part of the MAC.
const ALGORITHMS = {
  'hmac-md5.sig-alg.reg.int': { node: 'md5', truncOk: false },
  'hmac-sha1': { node: 'sha1', truncOk: false },
  'hmac-sha224': { node: 'sha224', truncOk: false },
  'hmac-sha256': { node: 'sha256', truncOk: false },
  'hmac-sha384': { node: 'sha384', truncOk: false },
  'hmac-sha512': { node: 'sha512', truncOk: false },
}

const DEFAULT_ALGORITHM = 'hmac-sha256'

// RFC 8945 §5.2.3: the permitted clock skew, in seconds, either side of now.
const DEFAULT_FUDGE = 300

export const TSIG_ERRORS = { 16: 'BADSIG', 17: 'BADKEY', 18: 'BADTIME', 22: 'BADTRUNC' }

/** md5 is spelled with a suffix; the rest are bare. Both forms accepted. */
function canonicalAlgorithm(name) {
  const lower = String(name || DEFAULT_ALGORITHM)
    .toLowerCase()
    .replace(/\.$/, '')
  if (ALGORITHMS[lower]) return lower
  const withSuffix = `${lower}.sig-alg.reg.int`
  if (ALGORITHMS[withSuffix]) return withSuffix
  throw new Error(`TSIG: unsupported algorithm "${name}"`)
}

/**
 * Accepts an object, or dig's -y spelling: "[algorithm:]name:base64secret".
 * The secret is base64 — that is how BIND, Knot and NSD all write it.
 */
export function parseKey(key) {
  if (!key) throw new Error('TSIG: a key is required')

  let name
  let secret
  let algorithm

  if (typeof key === 'object') {
    ;({ name, secret, algorithm } = key)
  } else {
    const parts = String(key).split(':')
    if (parts.length === 2) [name, secret] = parts
    else if (parts.length === 3) [algorithm, name, secret] = parts
    else
      throw new Error(
        'TSIG: expected "name:secret" or "algorithm:name:secret", or { name, secret, algorithm }',
      )
  }

  if (!name) throw new Error('TSIG: key name is required')
  if (!secret) throw new Error('TSIG: key secret is required')

  const algo = canonicalAlgorithm(algorithm)
  const raw = Buffer.from(secret, 'base64')
  // Buffer.from ignores invalid base64 rather than throwing, so a typo would
  // otherwise become a silently wrong MAC.
  if (raw.length === 0) throw new Error('TSIG: key secret is not valid base64')

  return {
    name: String(name).toLowerCase().replace(/\.$/, ''),
    secret: raw,
    algorithm: algo,
  }
}

/**
 * The signed-variables blob (RFC 8945 §4.3.3), which follows the message bytes
 * in the digest. Name and algorithm go in canonical (lowercased) wire form.
 */
function tsigVariables({ name, algorithm, timeSigned, fudge, error = 0, otherData }) {
  const other = otherData ?? Buffer.alloc(0)
  const head = Buffer.concat([
    encodeName(name),
    u16(CLASS_ANY),
    u32(0),
    encodeName(algorithm),
  ])
  const tail = Buffer.concat([
    u48(timeSigned),
    u16(fudge),
    u16(error),
    u16(other.length),
    other,
  ])
  return Buffer.concat([head, tail])
}

const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
// Time Signed is 48 bits, so it outlives the 2038 problem by design.
const u48 = (n) => {
  const b = Buffer.alloc(6)
  b.writeUIntBE(Number(n), 0, 6)
  return b
}

function computeMac({ key, message, variables, requestMac }) {
  const hmac = crypto.createHmac(ALGORITHMS[key.algorithm].node, key.secret)
  // RFC 8945 §5.3.1: a response digests the request's MAC first, length-prefixed.
  if (requestMac?.length) hmac.update(Buffer.concat([u16(requestMac.length), requestMac]))
  hmac.update(message)
  hmac.update(variables)
  return hmac.digest()
}

/**
 * Append a TSIG RR to `message`, signing it.
 *
 * The digest covers the message with its *original* ARCOUNT — the increment for
 * the TSIG RR itself happens only in the returned bytes (RFC 8945 §5.3.1).
 *
 * @returns {{ message: Buffer, mac: Buffer, timeSigned: number }}
 */
export function signMessage({
  message,
  key,
  fudge = DEFAULT_FUDGE,
  timeSigned = Math.floor(Date.now() / 1000),
  requestMac = null,
}) {
  const k = parseKey(key)
  if (message.length < 12) throw new Error('TSIG: short DNS message')

  const variables = tsigVariables({
    name: k.name,
    algorithm: k.algorithm,
    timeSigned,
    fudge,
  })
  const mac = computeMac({ key: k, message, variables, requestMac })

  const originalId = message.readUInt16BE(0)
  const rdata = Buffer.concat([
    encodeName(k.algorithm),
    u48(timeSigned),
    u16(fudge),
    u16(mac.length),
    mac,
    u16(originalId),
    u16(0), // Error
    u16(0), // Other Len
  ])

  const rr = Buffer.concat([
    encodeName(k.name),
    u16(TYPE_TSIG),
    u16(CLASS_ANY),
    u32(0), // TTL is always 0 — a TSIG must never be cached
    u16(rdata.length),
    rdata,
  ])

  const signed = Buffer.concat([message, rr])
  signed.writeUInt16BE(message.readUInt16BE(10) + 1, 10) // ARCOUNT

  return { message: signed, mac, timeSigned }
}

/**
 * Verify the TSIG on a received message against the MAC we sent.
 *
 * Returns { ok, error, tsig }. A message with no TSIG returns
 * ok:false with reason 'no TSIG', which the caller may treat as it likes —
 * some servers answer an unsigned error before ever reaching the key.
 */
export function verifyMessage({ message, key, requestMac = null, now = Date.now() }) {
  const k = parseKey(key)

  let found
  try {
    found = extractTsig(message)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (!found) return { ok: false, error: 'no TSIG' }

  const { tsig, stripped } = found

  if (tsig.name !== k.name) return { ok: false, error: `TSIG key mismatch: ${tsig.name}` }
  if (tsig.algorithm !== k.algorithm) {
    return { ok: false, error: `TSIG algorithm mismatch: ${tsig.algorithm}` }
  }
  if (tsig.error) {
    return {
      ok: false,
      error: `TSIG error: ${TSIG_ERRORS[tsig.error] ?? tsig.error}`,
      tsig,
    }
  }

  const skew = Math.abs(Math.floor(now / 1000) - tsig.timeSigned)
  if (skew > tsig.fudge) {
    return { ok: false, error: `TSIG time outside fudge by ${skew - tsig.fudge}s`, tsig }
  }

  const variables = tsigVariables({
    name: k.name,
    algorithm: k.algorithm,
    timeSigned: tsig.timeSigned,
    fudge: tsig.fudge,
    error: tsig.error,
    otherData: tsig.otherData,
  })
  const expected = computeMac({ key: k, message: stripped, variables, requestMac })

  // Truncated MACs are legal (RFC 8945 §5.2.2.1); compare the prefix actually sent.
  const want = expected.subarray(0, tsig.mac.length)
  if (tsig.mac.length < 10 || tsig.mac.length * 2 < expected.length) {
    return { ok: false, error: 'TSIG MAC truncated below the permitted minimum', tsig }
  }
  if (!crypto.timingSafeEqual(want, tsig.mac)) {
    return { ok: false, error: 'TSIG MAC mismatch', tsig }
  }

  return { ok: true, tsig }
}

/**
 * Pull the trailing TSIG RR off a message, returning it plus the message as it
 * was when signed: TSIG removed and ARCOUNT put back.
 *
 * The TSIG must be the last record (RFC 8945 §5.1), so this walks from the end
 * rather than parsing every section.
 */
export function extractTsig(message) {
  if (!Buffer.isBuffer(message) || message.length < 12) {
    throw new Error('TSIG: short DNS message')
  }
  const arcount = message.readUInt16BE(10)
  if (arcount === 0) return null

  const start = findLastRecordStart(message)
  if (start === null) return null

  let off = start
  const { name, next } = readName(message, off)
  off = next
  if (off + 10 > message.length) return null
  if (message.readUInt16BE(off) !== TYPE_TSIG) return null

  const rdlength = message.readUInt16BE(off + 8)
  let p = off + 10
  if (p + rdlength !== message.length) {
    throw new Error('TSIG: record is not the last thing in the message')
  }

  const algo = readName(message, p)
  p = algo.next
  const timeSigned = message.readUIntBE(p, 6)
  p += 6
  const fudge = message.readUInt16BE(p)
  p += 2
  const macSize = message.readUInt16BE(p)
  p += 2
  const mac = message.subarray(p, p + macSize)
  p += macSize
  const originalId = message.readUInt16BE(p)
  p += 2
  const error = message.readUInt16BE(p)
  p += 2
  const otherLen = message.readUInt16BE(p)
  p += 2
  const otherData = message.subarray(p, p + otherLen)

  // What the signer hashed: no TSIG, original ARCOUNT, original ID.
  const stripped = Buffer.from(message.subarray(0, start))
  stripped.writeUInt16BE(arcount - 1, 10)
  stripped.writeUInt16BE(originalId, 0)

  return {
    tsig: {
      name: name.toLowerCase(),
      algorithm: algo.name.toLowerCase(),
      timeSigned,
      fudge,
      mac,
      originalId,
      error,
      otherData,
    },
    stripped,
  }
}

function readName(buf, offset) {
  const labels = []
  let off = offset
  for (;;) {
    if (off >= buf.length) throw new Error('TSIG: name runs past the message')
    const len = buf[off]
    if (len === 0) return { name: labels.join('.'), next: off + 1 }
    // A TSIG owner name is never compressed (RFC 8945 §4.2).
    if (len & 0xc0) throw new Error('TSIG: compression pointer in a TSIG name')
    labels.push(buf.subarray(off + 1, off + 1 + len).toString('latin1'))
    off += 1 + len
  }
}

/**
 * Offset of the last record, found by walking forward through every section.
 * Cheaper alternatives all guess; a NOTIFY response is a handful of records.
 */
function findLastRecordStart(buf) {
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o))
  const total = counts[1] + counts[2] + counts[3]
  if (total === 0) return null

  let off = 12
  for (let i = 0; i < counts[0]; i++) {
    off = skipName(buf, off) + 4 // QTYPE + QCLASS
  }

  let last = null
  for (let i = 0; i < total; i++) {
    last = off
    const afterName = skipName(buf, off)
    if (afterName + 10 > buf.length) throw new Error('TSIG: truncated record')
    off = afterName + 10 + buf.readUInt16BE(afterName + 8)
  }
  return last
}

function skipName(buf, offset) {
  let off = offset
  for (;;) {
    if (off >= buf.length) throw new Error('TSIG: name runs past the message')
    const len = buf[off]
    if (len === 0) return off + 1
    if ((len & 0xc0) === 0xc0) return off + 2 // compression pointer ends the name
    off += 1 + len
  }
}

export default { signMessage, verifyMessage, parseKey, extractTsig }
