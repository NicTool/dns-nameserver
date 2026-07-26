import { EventEmitter } from 'node:events'

/**
 * Signer – optional DNSSEC stage between Publisher and Transport.
 *
 * Two integration points:
 *
 *   - In-memory (NativeNS): MemorySigner adds RRSIG/DNSKEY/NSEC(3) records to
 *     the in-process zone map before queries are answered.
 *
 *   - File-based: Rfc1035Signer post-processes the zone files written by
 *     Rfc1035Publisher (signs them, e.g. via dnssec-signzone) before
 *     Transport hands them to the downstream NS host.
 *
 * sign() receives the artifacts produced by Publisher, returns artifacts of
 * the same shape (possibly mutated in place) so the Transport contract is
 * unchanged.
 */
export class Signer extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
  }

  async sign(artifacts) {
    return artifacts
  }
}

export default Signer
