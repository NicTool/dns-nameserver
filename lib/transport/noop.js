import Transport from './base.js'

/**
 * NoopTransport – used by in-process engines (NativeNS) where the Publisher
 * already updates the serving state (e.g. MemoryPublisher swaps its zone map)
 * and no further movement is needed. The scheduling loop still runs so the
 * zone map stays fresh.
 */
export class NoopTransport extends Transport {
  async deliver(artifacts) {
    return { ...artifacts, transport: 'noop' }
  }
}

export default NoopTransport
