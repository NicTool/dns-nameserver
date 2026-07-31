import { signWith } from './dnssec-keys.js'
import { toRR } from './to-rr.js'

/**
 * RRset signing, per RFC 4034 §3.1.8.
 *
 * The rdata encoding comes from @nictool/dns-resource-record's getWireRdata(),
 * which is why the DNSSEC types were added there — a signature is over wire
 * bytes, and a second encoder would eventually disagree with the first about
 * some corner of some type, producing signatures that verify nowhere.
 */

const RRSIG_TYPE = 46
const DNSKEY_TYPE = 48
const NSEC_TYPE = 47

/** Uncompressed, lowercased owner name — RFC 4034 §6.2. */
export function canonicalName(name) {
  const labels = String(name).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  const parts = []
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

/**
 * Order an RRset by rdata, treated as unsigned octets — RFC 4034 §6.3. The
 * signature covers the records in this order, so a verifier that sorts
 * differently gets a different digest.
 */
export function canonicalOrder(rdatas) {
  return [...rdatas].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

/** Seconds since the epoch, as RRSIG's 32-bit timestamps. */
const asEpoch = (value) =>
  Math.floor((value instanceof Date ? value.getTime() : Number(value)) / 1000)

/** Label count excluding the root and any leading wildcard — RFC 4034 §3.1.3. */
export function labelCount(owner) {
  const labels = String(owner).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  return labels[0] === '*' ? labels.length - 1 : labels.length
}

/**
 * The RRSIG rdata up to but excluding the signature, which is both what gets
 * signed and the head of what gets published.
 */
export function rrsigPrefix({
  typeCovered,
  algorithm,
  labels,
  originalTtl,
  expiration,
  inception,
  keyTag,
  signerName,
}) {
  const head = Buffer.alloc(18)
  head.writeUInt16BE(typeCovered, 0)
  head.writeUInt8(algorithm, 2)
  head.writeUInt8(labels, 3)
  head.writeUInt32BE(originalTtl, 4)
  head.writeUInt32BE(expiration, 8)
  head.writeUInt32BE(inception, 12)
  head.writeUInt16BE(keyTag, 16)
  return Buffer.concat([head, canonicalName(signerName)])
}

/**
 * Sign one RRset.
 *
 * @param {object} args
 * @param {string} args.owner        owner name shared by every record
 * @param {number} args.typeCovered  numeric RR type
 * @param {number} args.ttl          the RRset's TTL, which is also Original TTL
 * @param {Buffer[]} args.rdatas     each record's wire rdata
 * @param {object} args.key          from loadKeys()
 * @returns {{ rdata: Buffer, signature: Buffer, expiration: number, inception: number }}
 */
export function signRRset({
  owner,
  typeCovered,
  ttl,
  rdatas,
  key,
  signerName = key.zone,
  inception = Date.now() - 3600_000,
  expiration = Date.now() + 30 * 86400_000,
  classId = 1,
}) {
  const inceptionAt = asEpoch(inception)
  const expiresAt = asEpoch(expiration)

  const prefix = rrsigPrefix({
    typeCovered,
    algorithm: key.algorithm,
    labels: labelCount(owner),
    originalTtl: ttl,
    expiration: expiresAt,
    inception: inceptionAt,
    keyTag: key.keyTag,
    signerName,
  })

  // RFC 4034 §3.1.8.1: RRSIG_RDATA | RR(1) | RR(2) | ..., each RR in canonical
  // form — owner, type, class, original TTL, rdlength, rdata.
  const name = canonicalName(owner)
  const records = canonicalOrder(rdatas).map((rdata) => {
    const meta = Buffer.alloc(10)
    meta.writeUInt16BE(typeCovered, 0)
    meta.writeUInt16BE(classId, 2)
    meta.writeUInt32BE(ttl, 4)
    meta.writeUInt16BE(rdata.length, 8)
    return Buffer.concat([name, meta, Buffer.from(rdata)])
  })

  const signature = signWith(key, Buffer.concat([prefix, ...records]))
  return {
    rdata: Buffer.concat([prefix, signature]),
    signature,
    expiration: expiresAt,
    inception: inceptionAt,
  }
}

/**
 * Type bitmap for NSEC — RFC 4034 §4.1.2. Types are grouped into 256-type
 * windows, each carrying only as many bytes as its highest type needs.
 */
export function typeBitmap(types) {
  const windows = new Map()
  for (const type of new Set(types)) {
    const window = type >> 8
    const bit = type & 0xff
    if (!windows.has(window)) windows.set(window, [])
    windows.get(window).push(bit)
  }

  const parts = []
  for (const window of [...windows.keys()].sort((a, b) => a - b)) {
    const bits = windows.get(window)
    const width = (Math.max(...bits) >> 3) + 1
    const bitmap = Buffer.alloc(width)
    for (const bit of bits) bitmap[bit >> 3] |= 0x80 >> (bit & 7)
    parts.push(Buffer.from([window, width]), bitmap)
  }
  return Buffer.concat(parts)
}

/** NSEC rdata: next owner name, then the bitmap of types present here. */
export function nsecRdata(nextOwner, types) {
  return Buffer.concat([canonicalName(nextOwner), typeBitmap(types)])
}

/**
 * Sort owner names in canonical order — RFC 4034 §6.1, comparing label by
 * label from the right. This decides the NSEC chain, so getting it wrong
 * produces a chain that denies the wrong names.
 */
export function sortOwners(names) {
  const key = (n) =>
    String(n).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean).reverse()
  return [...names].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === undefined) return -1
      if (y[i] === undefined) return 1
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    }
    return 0
  })
}

/**
 * Wire rdata for a stored NicTool record, via the resource-record library.
 * The owner is qualified here: the library requires a trailing dot, while the
 * rest of this package carries names without one.
 */
export function wireRdataFor(record, owner, ttl) {
  const fqdn = String(owner).endsWith('.') ? owner : `${owner}.`
  const rr = toRR(record, fqdn, ttl)
  return Buffer.from(rr.getWireRdata())
}

export const TYPES = { RRSIG: RRSIG_TYPE, DNSKEY: DNSKEY_TYPE, NSEC: NSEC_TYPE }

export default { signRRset, canonicalName, canonicalOrder, typeBitmap, sortOwners }
