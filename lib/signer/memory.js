import { loadKeys } from '../dnssec-keys.js'
import {
  canonicalName,
  nsecRdata,
  signRRset,
  sortOwners,
  wireRdataFor,
} from '../dnssec-sign.js'
import { soaAdmin, soaPrimary } from '../soa.js'
import { canonical, ownerFqdn } from '../zone-name.js'
import Signer from './base.js'

/**
 * MemorySigner – signs the in-process zone map so NativeNS can answer with
 * RRSIG, DNSKEY and NSEC.
 *
 * The one engine with no signing tool of its own, so the signing happens here,
 * over the wire rdata @nictool/dns-resource-record produces. Keys are read from
 * the same BIND-format keyset dnssec-keygen writes, so a zone can move between
 * this signer and the file signer without re-keying.
 *
 * The records it adds carry `wireRdata` — the exact bytes the signature covers.
 * Re-deriving them at answer time could only introduce a discrepancy, and a
 * signature over bytes nobody else produces verifies nowhere.
 */

// Numeric RR types, for RRSIG's type-covered field and the NSEC bitmap.
const TYPE_IDS = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  DS: 43,
  SSHFP: 44,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  TLSA: 52,
  CAA: 257,
}

export class MemorySigner extends Signer {
  constructor(opts = {}) {
    super(opts)
    this.keyset = opts.keyset || './data/dnssec'
    this.nsec3 = Boolean(opts.nsec3)
    this.validityDays = Number(opts.validityDays) || 30
    this.publisher = opts.publisher ?? null
  }

  /** MemoryPublisher owns the map; the signer edits it in place. */
  attach(publisher) {
    this.publisher = publisher
  }

  async sign(artifacts) {
    const zones = this.publisher?.zones
    if (!zones?.size) return artifacts

    if (this.nsec3) {
      // NSEC3 hashing is its own piece of work; saying so beats publishing an
      // NSEC chain to an operator who asked for NSEC3 and believes they got it.
      throw new Error('MemorySigner: NSEC3 is not implemented — use NSEC')
    }

    let signedZones = 0
    let signatures = 0

    for (const [name, entry] of zones) {
      const result = await this._signZone(name, entry)
      signedZones += 1
      signatures += result.signatures
    }

    const out = {
      ...artifacts,
      dnssec: { signed: signedZones, signatures, keyset: this.keyset, nsec3: false },
    }
    this.emit('signed', out.dnssec)
    return out
  }

  async _signZone(zoneName, entry) {
    const apex = canonical(entry.zone?.zone ?? zoneName)
    const { keys, errors } = await loadKeys(this.keyset, apex)

    for (const err of errors) {
      this.emit('error', new Error(`MemorySigner: ${err.file}: ${err.message}`))
    }
    if (!keys.length) {
      throw new Error(
        `MemorySigner: no usable keys for ${apex} in ${this.keyset} — generate them with ` +
          `dnssec-keygen -a ECDSAP256SHA256 -K ${this.keyset} -n ZONE ${apex}`,
      )
    }

    const zsk = keys.find((k) => !k.isKsk) ?? keys[0]
    const ksk = keys.find((k) => k.isKsk) ?? zsk
    const ttl = Number(entry.zone?.ttl) || 3600
    const inception = Date.now() - 3600_000
    const expiration = Date.now() + this.validityDays * 86400_000
    const sign = (owner, typeCovered, rdatas, key) =>
      signRRset({
        owner,
        typeCovered,
        ttl,
        rdatas,
        key,
        signerName: apex,
        inception,
        expiration,
      })

    // A second cycle must sign the zone as published, not the previous
    // signatures on top of it.
    const live = (entry.records ?? []).filter((r) => !r.deleted && !r.wireRdata)
    const added = []
    let signatures = 0

    const rrsets = new Map()
    const typesByOwner = new Map()
    const note = (owner, typeId) => {
      if (!typesByOwner.has(owner)) typesByOwner.set(owner, new Set())
      typesByOwner.get(owner).add(typeId)
    }

    for (const rec of live) {
      const type = String(rec.type ?? '').toUpperCase()
      if (type === 'SOA') continue // synthesized below, from the zone row
      const typeId = TYPE_IDS[type]
      if (!typeId) continue // NativeNS cannot serve it either

      const owner = ownerFqdn(rec, apex)
      let rdata
      try {
        rdata = wireRdataFor(rec, owner, Number(rec.ttl) || ttl)
      } catch (err) {
        // Skipping would publish a zone whose missing records are unsigned but
        // still served — worse than not signing it, and silent.
        throw new Error(
          `MemorySigner: cannot encode ${owner} ${type} in ${apex}: ${err.message.split('\n')[0]}`,
          { cause: err },
        )
      }

      const key = `${owner}|${typeId}`
      if (!rrsets.has(key)) rrsets.set(key, { owner, typeId, rdatas: [] })
      rrsets.get(key).rdatas.push(rdata)
      note(owner, typeId)
    }

    rrsets.set(`${apex}|${TYPE_IDS.SOA}`, {
      owner: apex,
      typeId: TYPE_IDS.SOA,
      rdatas: [soaRdata(entry.zone, apex, live)],
    })
    note(apex, TYPE_IDS.SOA)

    // DNSKEY at the apex, signed by the key-signing key.
    for (const key of keys) {
      added.push({
        type: 'DNSKEY',
        owner: apex,
        ttl,
        flags: key.flags,
        protocol: key.protocol,
        algorithm: key.algorithm,
        publickey: key.publicKey.toString('base64'),
        wireRdata: key.rdata,
      })
    }
    note(apex, TYPE_IDS.DNSKEY)

    added.push(
      rrsigRecord(
        apex,
        ttl,
        sign(
          apex,
          TYPE_IDS.DNSKEY,
          keys.map((k) => k.rdata),
          ksk,
        ),
        TYPE_IDS.DNSKEY,
      ),
    )
    signatures += 1

    for (const { owner, typeId, rdatas } of rrsets.values()) {
      added.push(rrsigRecord(owner, ttl, sign(owner, typeId, rdatas, zsk), typeId))
      signatures += 1
    }

    // Every name that exists gets RRSIG and NSEC in its bitmap, so note them
    // before the chain is built rather than while walking it.
    for (const owner of typesByOwner.keys()) {
      note(owner, TYPE_IDS.RRSIG)
      note(owner, TYPE_IDS.NSEC)
    }

    const owners = sortOwners([...typesByOwner.keys()])
    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i]
      const next = owners[(i + 1) % owners.length]
      const types = [...typesByOwner.get(owner)].sort((a, b) => a - b)
      const rdata = nsecRdata(next, types)

      added.push({ type: 'NSEC', owner, ttl, next, types, wireRdata: rdata })
      added.push(
        rrsigRecord(owner, ttl, sign(owner, TYPE_IDS.NSEC, [rdata], zsk), TYPE_IDS.NSEC),
      )
      signatures += 1
    }

    entry.records = [...live, ...added]
    return { signatures }
  }
}

/** typeCovered is inside the rdata; keeping it here saves re-parsing to match
 *  an RRSIG against the qtype it belongs to. */
function rrsigRecord(owner, ttl, sig, typeCovered) {
  return { type: 'RRSIG', owner, ttl, typeCovered, wireRdata: sig.rdata }
}

/** The SOA the zone row describes, in wire form. */
function soaRdata(zone, apex, records) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
  const timers = Buffer.alloc(20)
  timers.writeUInt32BE(num(zone?.serial, 1), 0)
  timers.writeUInt32BE(num(zone?.refresh, 86400), 4)
  timers.writeUInt32BE(num(zone?.retry, 7200), 8)
  timers.writeUInt32BE(num(zone?.expire, 1209600), 12)
  timers.writeUInt32BE(num(zone?.minimum, 3600), 16)
  return Buffer.concat([
    canonicalName(soaPrimary(zone, apex, records)),
    canonicalName(soaAdmin(zone, apex)),
    timers,
  ])
}

export default MemorySigner
