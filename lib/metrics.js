/**
 * PublishMetrics – timings and counts for one nameserver's publish cycles.
 *
 * Every export path runs through Nameserver.publishCycle, so this is the one
 * place that can measure them all the same way. Comparing "bind over rsync"
 * against "powerdns into gmysql" only means something if both are counted with
 * the same ruler, so the counts come from the zones the source returned rather
 * than from each publisher's own artifact shape — those disagree, and some
 * report no counts at all.
 */

export const STAGES = ['read', 'publish', 'sign', 'deliver']

const round = (ms) => Math.round(ms * 1000) / 1000

export class PublishMetrics {
  constructor() {
    this.count = 0
    this.failures = 0
    this.last = null
    this.lastFailure = null
    this._totalMs = 0
    this._minMs = null
    this._maxMs = null
    this._stageTotals = Object.fromEntries(STAGES.map((s) => [s, 0]))
  }

  recordSuccess({ stages, zoneCount, recordCount, skipped, deliveryFailures = 0 }) {
    const durationMs = STAGES.reduce((sum, s) => sum + (stages[s] ?? 0), 0)

    this.count += 1
    this._totalMs += durationMs
    this._minMs = this._minMs === null ? durationMs : Math.min(this._minMs, durationMs)
    this._maxMs = this._maxMs === null ? durationMs : Math.max(this._maxMs, durationMs)
    for (const s of STAGES) this._stageTotals[s] += stages[s] ?? 0

    this.last = {
      at: new Date().toISOString(),
      durationMs: round(durationMs),
      stages: Object.fromEntries(STAGES.map((s) => [s, round(stages[s] ?? 0)])),
      zoneCount,
      recordCount,
      skipped,
      deliveryFailures,
    }
    return this.last
  }

  recordFailure({ stage, durationMs, error }) {
    this.failures += 1
    this.lastFailure = {
      at: new Date().toISOString(),
      stage,
      durationMs: round(durationMs),
      message: error?.message ?? String(error),
    }
    return this.lastFailure
  }

  /** Plain object for status() — averages resolved, internals left behind. */
  toJSON() {
    return {
      count: this.count,
      failures: this.failures,
      durationMs: {
        last: this.last?.durationMs ?? null,
        avg: this.count ? round(this._totalMs / this.count) : null,
        min: this._minMs === null ? null : round(this._minMs),
        max: this._maxMs === null ? null : round(this._maxMs),
      },
      // Where the time actually goes, which is the point of collecting this:
      // a slow rsync and a slow zone render are different problems.
      avgStageMs: this.count
        ? Object.fromEntries(
            STAGES.map((s) => [s, round(this._stageTotals[s] / this.count)]),
          )
        : null,
      last: this.last,
      lastFailure: this.lastFailure,
    }
  }
}

/**
 * Count what the source handed over. `zones` is a Map of apex →
 * { zone, records }; anything else counts as nothing rather than throwing,
 * since a custom Source is free to return its own iterable.
 */
export function countZones(zones) {
  if (!zones || typeof zones.values !== 'function') {
    return { zoneCount: 0, recordCount: 0 }
  }
  let zoneCount = 0
  let recordCount = 0
  for (const entry of zones.values()) {
    zoneCount += 1
    if (Array.isArray(entry?.records)) recordCount += entry.records.length
  }
  return { zoneCount, recordCount }
}

export default PublishMetrics
