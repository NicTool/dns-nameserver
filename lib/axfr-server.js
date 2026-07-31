import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import net from 'node:net'

import { Packet, encodable, num, soaResource, toResource } from './wire.js'
import { canonical, ownerFqdn } from './zone-name.js'

/**
 * AxfrServer – answers zone transfers, so a secondary can pull from NicTool
 * itself rather than from a primary NicTool feeds.
 *
 * This is the counterpart to AxfrTransport, not a variant of it: the transport
 * tells a secondary to come and get a zone, this is what answers when it does.
 * MaraDNS `fetchzone`, BIND, Knot, NSD and CoreDNS's `transfer` plugin are all
 * clients of it.
 *
 * Transfers are TCP only — RFC 5936 §4.2 forbids AXFR over UDP. UDP is bound
 * anyway, for the SOA query a secondary makes first: it compares that serial
 * against its own before deciding to transfer, and dig and every real secondary
 * send it over UDP. Without it the listener answers a transfer nobody asks for.
 *
 * Authorization reuses the assignment that already exists: a peer is matched to
 * a nameserver by source address, and that nameserver's zones are exactly what
 * Source.getZones({ nameserverId }) returns. There is no separate ACL to keep in
 * step — the join that decides which zones a nameserver serves decides which it
 * may transfer.
 */

const TYPE_AXFR = 252
const TYPE_IXFR = 251

// RFC 5936 §2.2: a transfer opens and closes with the zone's SOA.
// 65535 is the TCP message ceiling; leave room for the length prefix and header.
const DEFAULT_MAX_MESSAGE = 16384

export class AxfrServer extends EventEmitter {
  constructor({
    listen = [{ address: '127.0.0.1', port: 53 }],
    source = null,
    nameservers = [],
    maxMessageSize = DEFAULT_MAX_MESSAGE,
    timeoutMs = 30000,
  } = {}) {
    super()
    this.listen = listen
    this.source = source
    this.maxMessageSize = maxMessageSize
    this.timeoutMs = timeoutMs
    this.setNameservers(nameservers)
    this._servers = []
    this._udpSockets = []
    this.state = 'stopped'
    this.transfers = 0
    this.refusals = 0
  }

  /**
   * Build the address -> nameserver index. Both `address`/`address6` and any
   * listen sockets count, since a secondary may transfer from any of its
   * interfaces.
   */
  setNameservers(nameservers = []) {
    this.byAddress = new Map()
    for (const ns of nameservers) {
      const id = ns.id ?? ns.nt_nameserver_id
      if (id == null) continue
      for (const addr of [ns.address, ns.address6]) {
        if (addr) this.byAddress.set(normalizeAddress(addr), { id, name: ns.name })
      }
      for (const l of Array.isArray(ns.listen) ? ns.listen : []) {
        if (l?.address)
          this.byAddress.set(normalizeAddress(l.address), { id, name: ns.name })
      }
    }
  }

  async start() {
    if (!this.source) throw new Error('AxfrServer: source is required')
    await this.source.connect?.()

    for (const l of this.listen) {
      const server = net.createServer((socket) => this._onConnection(socket))
      server.on('error', (err) => this.emit('error', err))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(l.port ?? 53, l.address ?? '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      this._servers.push(server)

      // Bind UDP to the port TCP actually got, not to the requested one: with
      // port 0 the two would otherwise land on different ephemeral ports and a
      // secondary's serial check would go nowhere.
      const boundPort = server.address().port
      const udp = dgram.createSocket(
        net.isIPv6(l.address ?? '127.0.0.1') ? 'udp6' : 'udp4',
      )
      udp.on('error', (err) => this.emit('error', err))
      udp.on('message', (msg, rinfo) => this._onDatagram(udp, msg, rinfo))
      await new Promise((resolve, reject) => {
        udp.once('error', reject)
        udp.bind(boundPort, l.address ?? '127.0.0.1', () => {
          udp.removeListener('error', reject)
          resolve()
        })
      })
      this._udpSockets.push(udp)
    }

    this.state = 'running'
    this.emit('started')
  }

  async stop() {
    for (const server of this._servers) {
      await new Promise((resolve) => server.close(resolve))
    }
    this._servers = []
    for (const udp of this._udpSockets) {
      await new Promise((resolve) => udp.close(resolve))
    }
    this._udpSockets = []
    await this.source?.disconnect?.()
    this.state = 'stopped'
    this.emit('stopped')
  }

  addresses() {
    return this._servers.map((s) => s.address()).filter(Boolean)
  }

  status() {
    return {
      state: this.state,
      listen: this.addresses(),
      authorized: this.byAddress.size,
      transfers: this.transfers,
      refusals: this.refusals,
    }
  }

  /**
   * UDP carries the serial check only. An AXFR arriving here is answered with
   * NOTIMP rather than ignored, so a misconfigured secondary is told why
   * instead of timing out.
   */
  async _onDatagram(socket, message, rinfo) {
    let request
    try {
      request = Packet.parse(message)
    } catch {
      return
    }
    const reply = (packet) =>
      socket.send(packet.toBuffer(), rinfo.port, rinfo.address, () => {})

    const question = request.questions?.[0]
    if (!question) {
      return reply(Packet.createErrorResponseFromRequest(request, Packet.RCODE.FORMERR))
    }
    if (question.type === TYPE_AXFR || question.type === TYPE_IXFR) {
      return reply(Packet.createErrorResponseFromRequest(request, Packet.RCODE.NOTIMP))
    }

    const authorized = await this._authorize(rinfo.address, question)
    if (authorized.error) {
      return reply(
        Packet.createErrorResponseFromRequest(request, Packet.RCODE[authorized.error]),
      )
    }
    if (question.type !== Packet.TYPE.SOA) {
      return reply(Packet.createErrorResponseFromRequest(request, Packet.RCODE.NOTIMP))
    }

    const { zone, records } = authorized.entry
    const apex = canonical(zone?.zone ?? '')
    const response = Packet.createResponseFromRequest(request)
    response.header.aa = 1
    response.answers.push(soaFor(apex, zone, records))
    reply(response)
  }

  _onConnection(socket) {
    socket.setTimeout(this.timeoutMs, () => socket.destroy())
    socket.on('error', () => socket.destroy())

    let buffer = Buffer.alloc(0)
    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // A message is length-prefixed; more than one may be pipelined.
      for (;;) {
        if (buffer.length < 2) return
        const len = buffer.readUInt16BE(0)
        if (buffer.length < 2 + len) return
        const message = buffer.subarray(2, 2 + len)
        buffer = buffer.subarray(2 + len)
        try {
          await this._handle(socket, message)
        } catch (err) {
          this.emit('error', err)
          socket.destroy()
          return
        }
      }
    })
  }

  async _handle(socket, message) {
    let request
    try {
      request = Packet.parse(message)
    } catch {
      return socket.destroy()
    }
    if (!request.questions?.length) return this._sendError(socket, request, 'FORMERR')

    const [question] = request.questions
    const authorized = await this._authorize(socket.remoteAddress, question)
    if (authorized.error) return this._sendError(socket, request, authorized.error)
    const entry = authorized.entry

    if (question.type === TYPE_AXFR) return this._sendTransfer(socket, request, entry)
    if (question.type === TYPE_IXFR) {
      // RFC 1995 §4: falling back to a full transfer is a valid IXFR response.
      return this._sendTransfer(socket, request, entry)
    }
    if (question.type === Packet.TYPE.SOA) return this._sendSoa(socket, request, entry)

    return this._sendError(socket, request, 'NOTIMP')
  }

  /**
   * Peer -> nameserver -> that nameserver's zones. Returns { entry } or
   * { error } naming the rcode to answer with.
   */
  async _authorize(remoteAddress, question) {
    const zoneName = canonical(question.name)
    const peer = normalizeAddress(remoteAddress)
    const client = this.byAddress.get(peer)

    if (!client) {
      this.refusals += 1
      this.emit('refused', { peer, zone: zoneName, reason: 'unknown peer' })
      return { error: 'REFUSED' }
    }

    const zones = await this.source.getZones({ nameserverId: client.id })
    const entry = zones.get(zoneName)
    if (!entry) {
      // Either the zone does not exist or it is not assigned to this peer; both
      // answer the same, so a probe cannot enumerate what it may not have.
      this.refusals += 1
      this.emit('refused', {
        peer,
        nameserver: client.name,
        zone: zoneName,
        reason: 'zone not assigned',
      })
      return { error: 'NOTAUTH' }
    }
    return { entry }
  }

  /** A secondary checks the SOA serial before deciding to transfer. */
  _sendSoa(socket, request, { zone, records }) {
    const apex = canonical(zone?.zone ?? '')
    const response = Packet.createResponseFromRequest(request)
    response.header.aa = 1
    response.answers.push(soaFor(apex, zone, records))
    this._write(socket, response)
  }

  _sendTransfer(socket, request, { zone, records }) {
    const apex = canonical(zone?.zone ?? '')
    const soa = soaFor(apex, zone, records)

    let resources
    try {
      resources = encodeZone(apex, zone, records)
    } catch (err) {
      // Sending a zone with records silently omitted would leave the secondary
      // authoritative for an incomplete copy, which is worse than no transfer.
      this.emit('error', err)
      return this._sendError(socket, request, 'SERVFAIL')
    }

    // RFC 5936 §2.2: SOA, the zone, then the SOA again.
    const sequence = [soa, ...resources, soa]
    let batch = []
    let size = 0

    const flush = () => {
      if (!batch.length) return
      const response = Packet.createResponseFromRequest(request)
      response.header.aa = 1
      response.answers = batch
      this._write(socket, response)
      batch = []
      size = 0
    }

    for (const resource of sequence) {
      const cost = estimateSize(resource)
      if (batch.length && size + cost > this.maxMessageSize) flush()
      batch.push(resource)
      size += cost
    }
    flush()

    this.transfers += 1
    this.emit('transferred', {
      zone: apex,
      peer: normalizeAddress(socket.remoteAddress),
      records: resources.length,
    })
  }

  _sendError(socket, request, rcode) {
    this._write(
      socket,
      Packet.createErrorResponseFromRequest(request, Packet.RCODE[rcode]),
    )
  }

  _write(socket, packet) {
    const body = packet.toBuffer()
    const framed = Buffer.alloc(2 + body.length)
    framed.writeUInt16BE(body.length, 0)
    body.copy(framed, 2)
    socket.write(framed)
  }
}

function soaFor(apex, zone, records) {
  const soaRec = records.find(
    (r) => !r.deleted && String(r.type ?? '').toUpperCase() === 'SOA',
  )
  const ttl = num(soaRec?.ttl ?? zone?.ttl, 3600)
  return soaResource(apex, ttl, zone ?? soaRec, apex, records)
}

/**
 * Every record in the zone, or a throw naming the types that cannot be encoded.
 * All-or-nothing on purpose: see _sendTransfer.
 */
function encodeZone(apex, zone, records) {
  const resources = []
  const unsupported = new Set()

  for (const rec of records) {
    if (rec.deleted) continue
    const type = String(rec.type ?? '').toUpperCase()
    if (type === 'SOA') continue // brackets the transfer instead

    const resource = toResource(rec, ownerFqdn(rec, apex), apex, zone)
    if (!resource || !encodable(resource)) {
      unsupported.add(type)
      continue
    }
    resources.push(resource)
  }

  if (unsupported.size) {
    throw new Error(
      `AxfrServer: cannot encode ${[...unsupported].sort().join(', ')} in ${apex}; ` +
        `refusing the transfer rather than sending an incomplete zone`,
    )
  }
  return resources
}

/** Enough to decide when to split a message; exactness is not required. */
function estimateSize(resource) {
  const name = String(resource.name ?? '').length + 2
  const rdata = JSON.stringify(resource).length
  return name + rdata + 12
}

/** ::ffff:10.0.0.1 and 10.0.0.1 are the same peer. */
function normalizeAddress(address) {
  const str = String(address ?? '').toLowerCase()
  const mapped = str.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? mapped[1] : str
}

export default AxfrServer
