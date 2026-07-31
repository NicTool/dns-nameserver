import { EventEmitter } from 'node:events'

/**
 * Backend – abstract live query responder.
 *
 * A Publisher pushes NicTool's zone truth outward as artifacts the nameserver
 * then serves on its own, so there is always a publish cycle between a change
 * and the answer. A Backend inverts that: the nameserver asks, and the Backend
 * answers each question from NicTool directly. Nothing is published, so
 * nothing goes stale — at the cost of a query-time database round trip.
 *
 * PowerdnsPipeBackend is the first: PowerDNS forks it and speaks its pipe
 * protocol over stdin/stdout.
 */
export class Backend extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
  }

  async connect() {}
  async disconnect() {}

  /**
   * Answer one question.
   *
   * @param {object} question  at least { qname, qclass, qtype }
   * @returns {Promise<Array>} rows in whatever shape the protocol writes
   */
  async lookup(_question) {
    throw new Error('Backend.lookup() not implemented')
  }

  /** Every record in a zone, for a zone transfer. */
  async axfr(_zoneId) {
    throw new Error('Backend.axfr() not implemented')
  }

  /** Serve requests until the input stream ends. */
  async run(_io = {}) {
    throw new Error('Backend.run() not implemented')
  }
}

export default Backend
