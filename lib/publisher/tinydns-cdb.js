import Publisher from './base.js'

/**
 * TinydnsCdbPublisher – compiles a tinydns data file and runs `tinydns-data`
 * to produce a data.cdb artifact. Deferred — scaffolded for the dispatch
 * abstraction so the configurator can offer tinydns as an engine choice.
 */
export class TinydnsCdbPublisher extends Publisher {
  async publish(_zones) {
    throw new Error('TinydnsCdbPublisher is not yet implemented')
  }
}

export default TinydnsCdbPublisher
