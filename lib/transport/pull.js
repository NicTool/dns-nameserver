import Transport from './base.js'

/**
 * PullTransport – the far side fetches; NicTool sends nothing.
 *
 * Distinct from NoopTransport, which means "the publisher already updated the
 * serving state". Here nothing was published at all and nothing will be sent:
 * a MaraDNS secondary runs `fetchzone` from cron, CoreDNS re-reads its store on
 * `zone_update_interval`. Naming that explicitly keeps such a nameserver
 * visible as a record rather than existing only as an address in someone
 * else's ACL.
 *
 * `interval` still drives the cadence, so the record's zone counts stay fresh
 * if you want them to; at 0 it reads once at startup and then idles.
 */
export class PullTransport extends Transport {
  constructor({ interval = 0, cooldown = 5, source = null } = {}) {
    super({ interval, cooldown })
    // Free text: how the far side gets its data, for the operator's benefit.
    this.pullSource = source
  }

  async deliver(artifacts) {
    return {
      ...artifacts,
      ok: true,
      transport: 'pull',
      // Nothing was delivered, and that is the configured intent rather than a
      // failure — so this must not look like a partial delivery.
      external: true,
      pullSource: this.pullSource ?? undefined,
    }
  }
}

export default PullTransport
