import Publisher from './base.js'

/**
 * NonePublisher – produces nothing.
 *
 * For a nameserver NicTool does not push to: a MaraDNS secondary running
 * fetchzone from cron, a CoreDNS pointed at a store it polls itself, anything
 * that fetches on its own schedule. Such a server is still worth a record —
 * it is real, it needs watching, and its address belongs in the primary's
 * transfer ACL — but rendering zone files for it would produce artifacts
 * nobody reads.
 *
 * The zones are still counted, so the record reports what the far side ought to
 * be holding, and a broken Source is still noticed.
 */
export class NonePublisher extends Publisher {
  async publish(zones) {
    const artifacts = {
      kind: 'none',
      zoneCount: zones?.size ?? 0,
      published: false,
    }
    this.emit('published', artifacts)
    return artifacts
  }
}

export default NonePublisher
