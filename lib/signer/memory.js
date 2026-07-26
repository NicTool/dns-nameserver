import Signer from './base.js'

/**
 * MemorySigner – signs the in-memory zone map produced by MemoryPublisher.
 * For each zone, adds DNSKEY at the apex and RRSIG records covering each
 * signed RRSet, plus NSEC (or NSEC3) chains as configured.
 *
 * Scaffolding only: a working implementation must load the keyset from
 * opts.keyset, sign with the configured algorithm, and update the
 * MemoryPublisher's zone map in place. Left as a follow-up so the pipeline
 * abstraction can be shipped without the crypto surface.
 */
export class MemorySigner extends Signer {
  async sign(_artifacts) {
    throw new Error('MemorySigner is not yet implemented — set [nameserver.dnssec].enabled = false')
  }
}

export default MemorySigner
