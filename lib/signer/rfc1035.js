import { DEFAULT_ALGORITHM, ensureKeys, signZoneFile } from '../dnssec.js'
import Signer from './base.js'

/**
 * Rfc1035Signer – signs the zone files Rfc1035Publisher wrote, using BIND's
 * dnssec-signzone.
 *
 * For bind, nsd and CoreDNS's `file` plugin, all of which read a signed zone
 * exactly as they read an unsigned one. Knot and PowerDNS sign for themselves
 * and never reach this stage.
 *
 * Each file is signed over itself, so the config the publisher already wrote —
 * naming the unsigned file — stays correct. The publisher rewrites the plain
 * zone every cycle, so there is always an unsigned rendering to sign.
 *
 * Keys are generated once per zone and then left alone. Rolling them belongs to
 * whoever operates the zone, on their schedule; a publish cycle that runs every
 * five minutes would otherwise re-key that often.
 */
export class Rfc1035Signer extends Signer {
  constructor(opts = {}) {
    super(opts)
    this.keyset = opts.keyset || './data/dnssec'
    this.algorithm = opts.algorithm || DEFAULT_ALGORITHM
    this.nsec3 = Boolean(opts.nsec3)
    this.salt = opts.salt ?? null
    this.keygen = opts.keygen || 'dnssec-keygen'
    this.signzone = opts.signzone || 'dnssec-signzone'
  }

  async sign(artifacts) {
    const files = Array.isArray(artifacts?.files) ? artifacts.files : []
    // Entries with no zone are the server config, which is not a zone file.
    const zones = files.filter((f) => f.zone && f.path)
    if (!zones.length) return artifacts

    const signed = []
    for (const { zone, path: file } of zones) {
      const keys = await ensureKeys({
        keyDir: this.keyset,
        zone,
        algorithm: this.algorithm,
        keygen: this.keygen,
      })
      await signZoneFile({
        zone,
        file,
        keyDir: this.keyset,
        nsec3: this.nsec3,
        salt: this.salt,
        signzone: this.signzone,
      })
      signed.push({ zone, keysCreated: keys.created.length })
    }

    const out = {
      ...artifacts,
      dnssec: {
        signed: signed.length,
        keysCreated: signed.reduce((n, s) => n + s.keysCreated, 0),
        algorithm: this.algorithm,
        nsec3: this.nsec3,
        keyset: this.keyset,
      },
    }
    this.emit('signed', out.dnssec)
    return out
  }
}

export default Rfc1035Signer
