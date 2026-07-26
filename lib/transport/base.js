import { EventEmitter } from 'node:events'

/**
 * Transport – schedules publish cycles and delivers artifacts.
 *
 * Two scheduling modes:
 *
 *   - Interval mode (interval > 0): periodic publish loop. Good for bulk
 *     exporters (bind/knot/nsd over rsync) where a minute of staleness is fine.
 *
 *   - Event mode (interval === 0): publish-on-demand. The Source emits
 *     'zoneChanged' and the Nameserver forwards it to this transport via
 *     notifyChange(). A cooldown window (default 5s) coalesces bursts so a
 *     flurry of record edits produces a single publish at the window boundary.
 *
 * Subclasses override deliver() to actually move artifacts (rsync, axfr, etc).
 * NoopTransport is the default for in-process engines like NativeNS.
 */
export class Transport extends EventEmitter {
  constructor({ interval = 30, cooldown = 5 } = {}) {
    super()
    this.interval = interval
    this.cooldown = cooldown
    this._timer = null
    this._cooldownTimer = null
    this._lastRun = 0
    this._pullAndDeliver = null
    this._running = null
    this._stopped = false
  }

  async start(pullAndDeliver) {
    this._pullAndDeliver = pullAndDeliver
    this._stopped = false
    await this._run()
    if (this.interval > 0) this._schedule()
  }

  async stop() {
    this._stopped = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    if (this._cooldownTimer) {
      clearTimeout(this._cooldownTimer)
      this._cooldownTimer = null
    }
  }

  async notifyChange() {
    if (this.interval !== 0 || this._stopped) return
    const elapsed = (Date.now() - this._lastRun) / 1000
    if (elapsed >= this.cooldown) {
      await this._run()
      return
    }
    if (this._cooldownTimer) return
    const waitMs = (this.cooldown - elapsed) * 1000
    this._cooldownTimer = setTimeout(() => {
      this._cooldownTimer = null
      this._run().catch(() => {})
    }, waitMs)
    if (this._cooldownTimer.unref) this._cooldownTimer.unref()
  }

  async _run() {
    if (this._running) return this._running
    this._running = this._runOnce().finally(() => {
      this._running = null
    })
    return this._running
  }

  async _runOnce() {
    this._lastRun = Date.now()
    try {
      const result = await this._pullAndDeliver()
      this.emit('delivered', result)
      return result
    } catch (err) {
      this.emit('error', err)
      throw err
    }
  }

  _schedule() {
    if (this._stopped) return
    this._timer = setTimeout(() => {
      this._run()
        .catch(() => {})
        .finally(() => {
          if (this.interval > 0 && !this._stopped) this._schedule()
        })
    }, this.interval * 1000)
    if (this._timer.unref) this._timer.unref()
  }

  async deliver(artifacts) {
    return artifacts
  }
}

export default Transport
