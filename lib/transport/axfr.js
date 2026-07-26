import Transport from './base.js'

/**
 * AxfrTransport – sends DNS NOTIFY so the remote NS pulls the zone via AXFR.
 * Scaffolded — wire up to an actual notify/xfr implementation in a follow-up.
 */
export class AxfrTransport extends Transport {
  constructor({ master, tsigKey = null, interval = 300, cooldown = 5 } = {}) {
    super({ interval, cooldown })
    this.master = master
    this.tsigKey = tsigKey
  }

  async deliver(_artifacts) {
    throw new Error('AxfrTransport is not yet implemented')
  }
}

export default AxfrTransport
