import Transport from './base.js'

/**
 * DbReplicationTransport – used when the Publisher writes into a database
 * that already replicates (e.g. PowerDNS + MySQL replication). Delivery is
 * implicit in the publish step, so this transport is effectively a noop —
 * its only job is to drive the schedule and emit 'delivered'.
 */
export class DbReplicationTransport extends Transport {
  async deliver(artifacts) {
    return { ok: true, implicit: true, artifacts }
  }
}

export default DbReplicationTransport
