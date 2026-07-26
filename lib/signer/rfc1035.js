import Signer from './base.js'

/**
 * Rfc1035Signer – signs RFC1035 zone files produced by Rfc1035Publisher.
 * Expected behavior: for each zone file, shell out to `dnssec-signzone`
 * (or an equivalent JS signer) using keys from opts.keyset, replace the
 * unsigned file with the signed output, and return the updated artifact
 * list so Transport copies the signed files.
 *
 * Scaffolding only — deferred until the keyset management story is wired up.
 */
export class Rfc1035Signer extends Signer {
  async sign(_artifacts) {
    throw new Error(
      'Rfc1035Signer is not yet implemented — set [nameserver.dnssec].enabled = false',
    )
  }
}

export default Rfc1035Signer
