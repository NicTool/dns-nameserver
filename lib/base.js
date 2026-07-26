import { EventEmitter } from 'node:events'

/**
 * Nameserver – abstract engine that composes Source + Publisher + (Signer) + Transport.
 *
 * Subclasses (NativeNS, BindNS, etc.) override start/stop to bind sockets or wire up
 * the specific engine. The publish pipeline is shared:
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
    engine,
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
    this.engine = engine
    this.listen = listen
    this.source = source
    this.publisher = publisher
    this.signer = signer
    this.transport = transport
    this.dnssec = dnssec
    this.state = 'stopped'
    this.lastPublish = null
    this.lastError = null
    this._onTransportError = null
    this._onZoneChanged = null
  }

  async publishCycle() {
    const zones = await this.source.getZones({ nameserverId: this.id })
    const artifacts = await this.publisher.publish(zones)
    const signed = this.signer ? await this.signer.sign(artifacts) : artifacts
    const delivered = this.transport
      ? await this.transport.deliver(signed)
      : { skipped: true }
    this.lastPublish = new Date().toISOString()
    this.emit('published', delivered)
    return delivered
  }

  async start() {
    const label = this.name || this.engine || this.id || 'Nameserver'
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
      engine: this.engine,
      state: this.state,
      listen: this.listen,
      lastPublish: this.lastPublish,
      lastError: this.lastError?.message ?? null,
    }
  }
}

export default Nameserver
