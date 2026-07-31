import dgram from 'node:dgram'
import net from 'node:net'

import { signMessage, verifyMessage } from './tsig.js'

/**
 * DNS NOTIFY (RFC 1996).
 *
 * Hand-encoded rather than run through dns2: a NOTIFY is a fixed twelve-byte
 * header plus one question, and dns2's Packet builder has no opcode 4 path.
 *
 * The message a primary sends is deliberately minimal — header and question,
 * no SOA in the answer section. RFC 1996 §3.7 lets the secondary treat the
 * answer as a hint at best, and every server re-queries the SOA before
 * transferring anyway.
 */

const OPCODE_NOTIFY = 4
const TYPE_SOA = 6
const CLASS_IN = 1

// QR=0, OPCODE=4, AA=1 — see RFC 1996 §3.1.
const NOTIFY_FLAGS = (OPCODE_NOTIFY << 11) | (1 << 10)

const RCODES = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
  9: 'NOTAUTH',
}

export function encodeName(name) {
  const labels = String(name)
    .replace(/\.$/, '')
    .split('.')
    .filter((l) => l.length > 0)

  const parts = []
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 63) throw new Error(`label longer than 63 bytes: "${label}"`)
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  parts.push(Buffer.from([0]))

  const encoded = Buffer.concat(parts)
  if (encoded.length > 255) throw new Error(`name longer than 255 bytes: "${name}"`)
  return encoded
}

export function encodeNotify({ id, zone }) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id & 0xffff, 0)
  header.writeUInt16BE(NOTIFY_FLAGS, 2)
  header.writeUInt16BE(1, 4) // QDCOUNT

  const question = Buffer.alloc(4)
  question.writeUInt16BE(TYPE_SOA, 0)
  question.writeUInt16BE(CLASS_IN, 2)

  return Buffer.concat([header, encodeName(zone), question])
}

/** Header fields only — the response body carries nothing a sender acts on. */
export function decodeResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('short DNS message')
  const flags = buf.readUInt16BE(2)
  const rcode = flags & 0x0f
  return {
    id: buf.readUInt16BE(0),
    qr: (flags >> 15) & 1,
    opcode: (flags >> 11) & 0x0f,
    aa: (flags >> 10) & 1,
    rcode,
    rcodeName: RCODES[rcode] ?? `RCODE${rcode}`,
  }
}

/** "10.0.0.1", "10.0.0.1:5353", "[::1]:5353" or { address, port }. */
export function parseTarget(target, defaultPort = 53) {
  if (target && typeof target === 'object') {
    if (!target.address) throw new Error('notify target needs an address')
    return { address: target.address, port: Number(target.port) || defaultPort }
  }

  const str = String(target).trim()
  if (!str) throw new Error('notify target needs an address')

  const bracketed = str.match(/^\[(.+)\]:(\d+)$/)
  if (bracketed) return { address: bracketed[1], port: Number(bracketed[2]) }
  if (str.startsWith('[') && str.endsWith(']')) {
    return { address: str.slice(1, -1), port: defaultPort }
  }

  // A bare IPv6 literal has colons of its own, so only split when what follows
  // the last colon is a port and the rest is not itself an IPv6 address.
  const lastColon = str.lastIndexOf(':')
  if (lastColon > 0 && !net.isIPv6(str)) {
    const maybePort = str.slice(lastColon + 1)
    if (/^\d+$/.test(maybePort)) {
      return { address: str.slice(0, lastColon), port: Number(maybePort) }
    }
  }
  return { address: str, port: defaultPort }
}

/**
 * Send one NOTIFY and wait for the matching response.
 *
 * UDP, so a lost packet looks the same as a silent server: `attempts` covers
 * both. Resolves with the outcome instead of throwing — one unreachable
 * secondary should not fail the whole delivery.
 */
export function sendNotify({
  zone,
  address,
  port = 53,
  timeoutMs = 2000,
  attempts = 3,
  tsigKey = null,
  socketFactory = dgram.createSocket,
}) {
  const type = net.isIPv6(address) ? 'udp6' : 'udp4'
  const id = 1 + Math.floor(Math.random() * 0xfffe)
  let message = encodeNotify({ id, zone })
  let requestMac = null
  if (tsigKey) {
    const signed = signMessage({ message, key: tsigKey })
    message = signed.message
    requestMac = signed.mac
  }

  return new Promise((resolve) => {
    const socket = socketFactory(type)
    let tries = 0
    let timer = null
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve({ zone, address, port, ...result })
    }

    socket.on('message', (buf) => {
      let res
      try {
        res = decodeResponse(buf)
      } catch (err) {
        return finish({ ok: false, error: err.message })
      }
      // A stray packet on this socket is not our answer; keep waiting.
      if (res.id !== id || res.qr !== 1) return

      // A signed request deserves a signed reply; accepting an unsigned one
      // would let anything on the path forge the acknowledgement.
      let tsig
      if (tsigKey) {
        tsig = verifyMessage({ message: buf, key: tsigKey, requestMac })
        if (!tsig.ok) {
          return finish({
            ok: false,
            rcode: res.rcodeName,
            error: `NOTIFY response failed TSIG: ${tsig.error}`,
            attempts: tries,
          })
        }
      }

      finish({
        ok: res.rcode === 0,
        rcode: res.rcodeName,
        error: res.rcode === 0 ? undefined : `NOTIFY refused: ${res.rcodeName}`,
        signed: tsigKey ? true : undefined,
        attempts: tries,
      })
    })

    socket.on('error', (err) => finish({ ok: false, error: err.message }))

    const attempt = () => {
      if (settled) return
      if (tries >= attempts) {
        return finish({
          ok: false,
          error: `no response after ${attempts} attempt(s)`,
          attempts: tries,
        })
      }
      tries += 1
      socket.send(message, port, address, (err) => {
        if (err) finish({ ok: false, error: err.message, attempts: tries })
      })
      timer = setTimeout(attempt, timeoutMs)
    }

    attempt()
  })
}

export default sendNotify
