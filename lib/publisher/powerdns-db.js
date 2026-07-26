import Publisher from './base.js'

/**
 * PowerdnsDbPublisher – writes zones into a PowerDNS SQL backend (domains,
 * records tables). Deferred — scaffolded for the dispatch abstraction so
 * the configurator can offer powerdns as an engine choice.
 */
export class PowerdnsDbPublisher extends Publisher {
  async publish(_zones) {
    throw new Error('PowerdnsDbPublisher is not yet implemented')
  }
}

export default PowerdnsDbPublisher
