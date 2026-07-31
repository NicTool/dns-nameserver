import net from 'node:net'

/**
 * Minimal RESP2 client — enough for a publisher, and no more.
 *
 * A publisher writes in bursts on an interval rather than per query, so it does
 * not need pooling, cluster routing or reconnect logic. The commands used are
 * AUTH, SELECT, MULTI, DEL, HSET, EXEC, and HGETALL/HKEYS for verification.
 * Hand-rolled to keep a full Redis client out of the dependency graph for what
 * is, for now, a comparison experiment. If this becomes a supported deployment
 * target, swap in the official client rather than growing this.
 */

const CRLF = '\r\n'

export function encodeCommand(args) {
  const parts = [`*${args.length}${CRLF}`]
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8')
    parts.push(`$${buf.length}${CRLF}`, buf, CRLF)
  }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
}

export class RespError extends Error {}

/**
 * Parse one reply from `buf` at `offset`.
 * @returns {{ value: any, next: number }|null} null when more bytes are needed.
 */
export function parseReply(buf, offset = 0) {
  if (offset >= buf.length) return null
  const type = String.fromCharCode(buf[offset])
  const lineEnd = buf.indexOf(CRLF, offset)
  if (lineEnd === -1) return null

  const line = buf.toString('utf8', offset + 1, lineEnd)
  const afterLine = lineEnd + 2

  switch (type) {
    case '+':
      return { value: line, next: afterLine }
    case '-':
      return { value: new RespError(line), next: afterLine }
    case ':':
      return { value: Number(line), next: afterLine }
    case '$': {
      const len = Number(line)
      if (len === -1) return { value: null, next: afterLine }
      if (buf.length < afterLine + len + 2) return null
      return {
        value: buf.toString('utf8', afterLine, afterLine + len),
        next: afterLine + len + 2,
      }
    }
    case '*': {
      const count = Number(line)
      if (count === -1) return { value: null, next: afterLine }
      const items = []
      let cursor = afterLine
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor)
        if (!item) return null
        items.push(item.value)
        cursor = item.next
      }
      return { value: items, next: cursor }
    }
    default:
      throw new RespError(`unexpected RESP type byte "${type}"`)
  }
}

export class RespClient {
  constructor({ address = '127.0.0.1:6379', password = null, db = null } = {}) {
    const [host, port] = splitAddress(address)
    this.host = host
    this.port = port
    this.password = password
    this.db = db
    this.socket = null
    this._buffer = Buffer.alloc(0)
    // One reply per queued resolver, in order — RESP2 has no request ids, so
    // ordering is the only correlation available.
    this._pending = []
  }

  async connect() {
    if (this.socket) return
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      socket.setNoDelay(true)
      socket.once('connect', () => {
        socket.removeListener('error', reject)
        this.socket = socket
        resolve()
      })
      socket.once('error', reject)
    })

    this.socket.on('data', (chunk) => this._onData(chunk))
    this.socket.on('error', (err) => this._failAll(err))
    this.socket.on('close', () => this._failAll(new RespError('connection closed')))

    if (this.password) await this.command('AUTH', this.password)
    if (this.db != null) await this.command('SELECT', this.db)
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    for (;;) {
      let reply
      try {
        reply = parseReply(this._buffer, 0)
      } catch (err) {
        return this._failAll(err)
      }
      if (!reply) return
      this._buffer = this._buffer.subarray(reply.next)
      const waiter = this._pending.shift()
      if (!waiter) continue
      if (reply.value instanceof RespError) waiter.reject(reply.value)
      else waiter.resolve(reply.value)
    }
  }

  _failAll(err) {
    const pending = this._pending
    this._pending = []
    for (const w of pending) w.reject(err)
  }

  command(...args) {
    return this.pipeline([args]).then(([one]) => one)
  }

  /** Send several commands in one write and collect their replies in order. */
  async pipeline(commands) {
    if (!this.socket) throw new RespError('not connected')
    const replies = commands.map(
      () => new Promise((resolve, reject) => this._pending.push({ resolve, reject })),
    )
    this.socket.write(Buffer.concat(commands.map(encodeCommand)))
    return Promise.all(replies)
  }

  async quit() {
    if (!this.socket) return
    try {
      await this.command('QUIT')
    } catch {
      /* the server closing first is the normal outcome */
    }
    this.socket.destroy()
    this.socket = null
  }
}

function splitAddress(address) {
  const str = String(address)
  const bracketed = str.match(/^\[(.+)\]:(\d+)$/)
  if (bracketed) return [bracketed[1], Number(bracketed[2])]
  const idx = str.lastIndexOf(':')
  if (idx === -1) return [str, 6379]
  return [str.slice(0, idx), Number(str.slice(idx + 1)) || 6379]
}

export default RespClient
