import { EventEmitter } from 'node:events'

import { PublishMetrics, STAGES as STAGE_ORDER, countZones } from './metrics.js'

/**
 * Nameserver – composes Source + Publisher + (Signer) + Transport.
 *
 * Subclasses (NativeNS, BindNS, etc.) override start/stop to bind sockets or wire up
 * the specific software. `type` is which one — the nt_nameserver_export_type name
 * the API stores, so the runtime and the record agree. The publish pipeline is shared:
 *
 *   Source.getZones → Publisher.publish → Signer.sign → Transport.deliver
 *
 * Transport drives the cadence (interval or event-mode); it pulls the pipeline by
 * calling the bound `publishCycle` passed into its start().
 */
export class Nameserver extends EventEmitter {
  constructor({
    id,
    name,
    type,
    listen = [],
    source = null,
    publisher = null,
    signer = null,
    transport = null,
    dnssec = null,
  } = {}) {
    super()
    this.id = id
    this.name = name
    this.type = type
    this.listen = listen
    this.source = source
    this.publisher = publisher
    this.signer = signer
    this.transport = transport
    this.dnssec = dnssec
    this.state = 'stopped'
    this.lastPublish = null
    this.lastError = null
    this.metrics = new PublishMetrics()
    this._onTransportError = null
    this._onZoneChanged = null
  }

  async publishCycle() {
    const stages = { read: 0, publish: 0, sign: 0, deliver: 0 }
    let mark = performance.now()
    // Which stage to blame if this throws — a failed rsync and a zone that
    // won't render are different problems.
    let stage = 'read'

    const lap = (name) => {
      const now = performance.now()
      stages[name] = now - mark
      mark = now
    }

    try {
      const zones = await this.source.getZones({ nameserverId: this.id })
      lap('read')
      const { zoneCount, recordCount } = countZones(zones)

      stage = 'publish'
      const artifacts = await this.publisher.publish(zones)
      lap('publish')

      stage = 'sign'
      const signed = this.signer ? await this.signer.sign(artifacts) : artifacts
      lap('sign')

      stage = 'deliver'
      // Zone names come from here rather than the artifacts: tinydns-cdb and
      // powerdns-db report counts only, so a transport that needs to name the
      // zones it delivered (AXFR sends one NOTIFY each) has nothing to read.
      const context = {
        zones: [...zones.keys()],
        nameserver: { id: this.id, name: this.name, type: this.type },
      }
      const delivered = this.transport
        ? await this.transport.deliver(signed, context)
        : { skipped: true }
      lap('deliver')

      this.lastPublish = new Date().toISOString()
      this.metrics.recordSuccess({
        stages,
        zoneCount,
        recordCount,
        // Publishers that cannot comment a bad record out in place report it
        // instead; a rising count here is a data problem, not a slow publish.
        skipped: Array.isArray(signed?.skipped) ? signed.skipped.length : 0,
        // A transport that reaches several destinations reports the ones it
        // could not. One refusing secondary must not fail the whole publish, so
        // it arrives here rather than as a thrown error.
        deliveryFailures: Array.isArray(delivered?.failures)
          ? delivered.failures.length
          : 0,
      })
      this.emit('published', delivered)
      return delivered
    } catch (err) {
      const elapsed = STAGE_ORDER.reduce((sum, s) => sum + stages[s], 0)
      this.metrics.recordFailure({
        stage,
        durationMs: elapsed + (performance.now() - mark),
        error: err,
      })
      throw err
    }
  }

  async start() {
    const label = this.name || this.type || this.id || 'Nameserver'
    if (!this.source) throw new Error(`${label}: source is required`)
    if (!this.publisher) throw new Error(`${label}: publisher is required`)

    await this.source.connect?.()

    this._removeListeners()

    if (this.transport) {
      this._onTransportError = (err) => {
        this.lastError = err
        this.emit('error', err)
      }
      this.transport.on('error', this._onTransportError)
      await this.transport.start(() => this.publishCycle())
    } else {
      await this.publishCycle()
    }

    if (this.source.on) {
      // the transport emits its own 'error'; swallow here so a failed publish
      // does not surface as an unhandled rejection
      this._onZoneChanged = () => {
        Promise.resolve(this.transport?.notifyChange?.()).catch(() => {})
      }
      this.source.on('zoneChanged', this._onZoneChanged)
    }

    this.state = 'running'
    this.emit('started')
  }

  async stop() {
    await this.transport?.stop?.()
    await this.source?.disconnect?.()
    // Publishers hold connections too — PowerdnsDbPublisher a MySQL pool,
    // CorednsRedisPublisher a socket. Leaving them open kept the process alive
    // after a clean stop().
    await this.publisher?.disconnect?.()
    this._removeListeners()
    this.state = 'stopped'
    this.emit('stopped')
  }

  _removeListeners() {
    if (this._onTransportError) {
      this.transport?.removeListener?.('error', this._onTransportError)
      this._onTransportError = null
    }
    if (this._onZoneChanged) {
      this.source?.removeListener?.('zoneChanged', this._onZoneChanged)
      this._onZoneChanged = null
    }
  }

  async reload() {
    return this.publishCycle()
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      state: this.state,
      listen: this.listen,
      lastPublish: this.lastPublish,
      lastError: this.lastError?.message ?? null,
      publisher: this.publisher?.constructor?.name ?? null,
      transport: this.transport?.constructor?.name ?? null,
      publish: this.metrics.toJSON(),
    }
  }
}

export default Nameserver
