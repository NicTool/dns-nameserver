import { parseTarget, sendNotify } from '../notify.js'
import { parseKey } from '../tsig.js'
import Transport from './base.js'

/**
 * AxfrTransport – delivery by zone transfer.
 *
 * The publisher has already put the data where a primary reads it: zone files
 * for bind/knot/nsd, rows for powerdns. This moves no bytes of its own. It
 * sends a DNS NOTIFY per zone so each secondary transfers now rather than
 * waiting out its SOA refresh, which is what makes AXFR an alternative to
 * rsync rather than an addition to it.
 *
 * Two things must be true on the far side, and neither is ours to enforce: the
 * primary has to permit the transfer (`allow-transfer` / `provide-xfr` / an
 * ACL), and the secondary has to accept NOTIFY from us. The config generators
 * emit both when given the same `notify` list.
 */
export class AxfrTransport extends Transport {
  constructor({
    notify = [],
    master = null,
    tsigKey = null,
    port = 53,
    timeoutMs = 2000,
    attempts = 3,
    concurrency = 16,
    interval = 300,
    cooldown = 5,
  } = {}) {
    super({ interval, cooldown })

    // Fail here rather than per-cycle: a malformed key is a config error.
    this.tsigKey = tsigKey ? parseKey(tsigKey) : null

    const list = Array.isArray(notify) ? notify : [notify]
    // `master` is the older single-target spelling.
    const raw = list.filter(Boolean).length
      ? list.filter(Boolean)
      : master
        ? [master]
        : []
    if (!raw.length) {
      throw new Error(
        'AxfrTransport: notify is required (e.g. notify: ["ns2.example.com", "10.0.0.3:5353"])',
      )
    }

    this.targets = raw.map((t) => parseTarget(t, port))
    this.timeoutMs = timeoutMs
    this.attempts = attempts
    this.concurrency = Math.max(1, concurrency)
  }

  async deliver(artifacts, context = {}) {
    const zones = zoneNames(artifacts, context)
    if (!zones.length) return { ok: true, notified: 0, skipped: 'no zones published' }

    const jobs = []
    for (const zone of zones) {
      for (const target of this.targets) jobs.push({ zone, target })
    }

    const results = await this._runBounded(jobs)
    const failures = results.filter((r) => !r.ok)

    return {
      ok: failures.length === 0,
      transport: 'axfr',
      zones: zones.length,
      targets: this.targets.length,
      notified: results.length - failures.length,
      failures,
    }
  }

  // A secondary that is simply off costs one timeout per zone, so the fan-out
  // runs in parallel: 300 zones across two targets is 600 packets, and
  // serially that is twenty minutes of waiting.
  async _runBounded(jobs) {
    const results = []
    let next = 0

    const worker = async () => {
      while (next < jobs.length) {
        const { zone, target } = jobs[next++]
        results.push(
          await sendNotify({
            zone,
            address: target.address,
            port: target.port,
            timeoutMs: this.timeoutMs,
            attempts: this.attempts,
            tsigKey: this.tsigKey,
          }),
        )
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, jobs.length) }, worker),
    )
    return results
  }
}

function zoneNames(artifacts, context) {
  if (Array.isArray(context?.zones) && context.zones.length) return context.zones
  // deliver() called without a context; the file publishers at least name theirs.
  const files = Array.isArray(artifacts?.files) ? artifacts.files : []
  return [...new Set(files.map((f) => f.zone).filter(Boolean))]
}

export default AxfrTransport
