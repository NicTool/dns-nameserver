// A hand-rolled RESP2 subset, so the wire format is asserted directly.
import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { RespClient, RespError, encodeCommand, parseReply } from '../lib/resp.js'

describe('encodeCommand', () => {
  it('writes an array of bulk strings', () => {
    assert.equal(
      encodeCommand(['HSET', 'k', 'f', 'v']).toString(),
      '*4\r\n$4\r\nHSET\r\n$1\r\nk\r\n$1\r\nf\r\n$1\r\nv\r\n',
    )
  })

  it('counts bytes, not characters', () => {
    // A multi-byte value would otherwise declare a short length and desync.
    const out = encodeCommand(['SET', 'k', 'héllo']).toString()
    assert.match(out, /\$6\r\nhéllo/)
  })
})

describe('parseReply', () => {
  it('reads each RESP2 type', () => {
    assert.equal(parseReply(Buffer.from('+OK\r\n')).value, 'OK')
    assert.equal(parseReply(Buffer.from(':42\r\n')).value, 42)
    assert.equal(parseReply(Buffer.from('$3\r\nabc\r\n')).value, 'abc')
    assert.equal(parseReply(Buffer.from('$-1\r\n')).value, null)
    assert.deepEqual(parseReply(Buffer.from('*2\r\n$1\r\na\r\n:7\r\n')).value, ['a', 7])
    assert.equal(parseReply(Buffer.from('*-1\r\n')).value, null)
  })

  it('surfaces an error reply as an Error rather than a string', () => {
    const { value } = parseReply(Buffer.from('-WRONGTYPE nope\r\n'))
    assert.ok(value instanceof RespError)
    assert.equal(value.message, 'WRONGTYPE nope')
  })

  it('returns null when the buffer is short, so a split packet waits', () => {
    assert.equal(parseReply(Buffer.from('$5\r\nabc')), null)
    assert.equal(parseReply(Buffer.from('*2\r\n$1\r\na\r\n')), null)
    assert.equal(parseReply(Buffer.from('+OK')), null)
  })

  it('reports where the next reply starts', () => {
    const buf = Buffer.from('+OK\r\n:1\r\n')
    const first = parseReply(buf)
    assert.equal(first.next, 5)
    assert.equal(parseReply(buf, first.next).value, 1)
  })

  it('rejects an unknown type byte', () => {
    assert.throws(() => parseReply(Buffer.from('?x\r\n')), /unexpected RESP type byte/)
  })
})

describe('RespClient', () => {
  let server
  let port
  let received

  beforeEach(async () => {
    received = []
    server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk.toString())
        // One +OK per command in the batch, counted by the leading '*'.
        const count = (chunk.toString().match(/^\*/gm) ?? []).length
        socket.write('+OK\r\n'.repeat(count || 1))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })

  afterEach(() => server.close())

  it('resolves replies in the order the commands were sent', async () => {
    const c = new RespClient({ address: `127.0.0.1:${port}` })
    await c.connect()
    const out = await c.pipeline([['MULTI'], ['DEL', 'k'], ['EXEC']])
    assert.deepEqual(out, ['OK', 'OK', 'OK'])
    assert.equal(received.length, 1, 'a pipeline is a single write')
    await c.quit()
  })

  it('reassembles a reply split across packets', async () => {
    server.close()
    server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('$5\r\nhel')
        setTimeout(() => socket.write('lo\r\n'), 20)
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))

    const c = new RespClient({ address: `127.0.0.1:${server.address().port}` })
    await c.connect()
    assert.equal(await c.command('GET', 'k'), 'hello')
    await c.quit()
  })

  it('rejects in-flight commands when the connection drops', async () => {
    server.close()
    server = net.createServer((socket) => socket.on('data', () => socket.destroy()))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))

    const c = new RespClient({ address: `127.0.0.1:${server.address().port}` })
    await c.connect()
    await assert.rejects(() => c.command('PING'), /connection closed|ECONNRESET/)
  })

  it('refuses to send before connecting', async () => {
    const c = new RespClient({ address: `127.0.0.1:${port}` })
    await assert.rejects(() => c.command('PING'), /not connected/)
  })

  it('defaults the port', () => {
    assert.equal(new RespClient({ address: 'localhost' }).port, 6379)
    assert.equal(new RespClient({ address: '[::1]:6390' }).host, '::1')
    assert.equal(new RespClient({ address: '[::1]:6390' }).port, 6390)
  })
})
