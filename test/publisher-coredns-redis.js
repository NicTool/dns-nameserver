// Exercised against a real Redis when one is reachable, because the value that
// matters here is the exact layout the CoreDNS plugin reads — a mock would only
// confirm what this code already believes.
//
// Point NT_REDIS_TEST at an instance to run these; skipped otherwise.
import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach } from 'node:test'

import CorednsRedisPublisher from '../lib/publisher/coredns-redis.js'
import { RespClient } from '../lib/resp.js'

const ADDRESS = process.env.NT_REDIS_TEST || '127.0.0.1:6379'
const PREFIX = '_nttest:'

let reachable = false
let probe

before(async () => {
  probe = new RespClient({ address: ADDRESS })
  try {
    await probe.connect()
    await probe.command('PING')
    reachable = true
  } catch {
    reachable = false
  }
})

after(async () => {
  if (reachable) {
    const keys = await probe.command('KEYS', `${PREFIX}*`)
    if (Array.isArray(keys) && keys.length) await probe.command('DEL', ...keys)
  }
  await probe?.quit()
})

const zoneMap = (records, zone = {}) =>
  new Map([
    [
      'r.example',
      {
        zone: { zone: 'r.example', ttl: 300, mailaddr: 'hostmaster.r.example', ...zone },
        records,
      },
    ],
  ])

const publisher = () => new CorednsRedisPublisher({ address: ADDRESS, keyPrefix: PREFIX })

async function doc(label) {
  const raw = await probe.command('HGET', `${PREFIX}r.example.`, label)
  return raw === null ? null : JSON.parse(raw)
}

describe('CorednsRedisPublisher', () => {
  beforeEach(async (t) => {
    if (!reachable) return t.skip(`no redis at ${ADDRESS}`)
    const keys = await probe.command('KEYS', `${PREFIX}*`)
    if (Array.isArray(keys) && keys.length) await probe.command('DEL', ...keys)
  })

  it('keys the hash on the zone with a trailing dot, which is how zones are found', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      await p.publish(zoneMap([{ id: 1, type: 'A', owner: '@', address: '1.2.3.4' }]))
      // The plugin SCANs for prefix*suffix, so this key is the zone declaration.
      assert.deepEqual(await probe.command('KEYS', `${PREFIX}*`), [`${PREFIX}r.example.`])
      assert.equal(await probe.command('TYPE', `${PREFIX}r.example.`), 'hash')
    } finally {
      await p.disconnect()
    }
  })

  it('puts the apex under "@" with the synthesized SOA', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      await p.publish(
        zoneMap([
          { id: 1, type: 'NS', owner: '@', dname: 'ns1.r.example.' },
          { id: 2, type: 'A', owner: '@', address: '1.2.3.4' },
        ]),
      )
      const apex = await doc('@')
      assert.equal(apex.soa.ns, 'ns1.r.example.')
      assert.equal(apex.soa.MBox, 'hostmaster.r.example.')
      assert.deepEqual(apex.a, [{ ip: '1.2.3.4' }])
    } finally {
      await p.disconnect()
    }
  })

  it('groups every type for a label into one document, each an array', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      await p.publish(
        zoneMap([
          { id: 1, type: 'A', owner: 'www', address: '1.1.1.1' },
          { id: 2, type: 'A', owner: 'www', address: '1.1.1.2', ttl: 60 },
          { id: 3, type: 'AAAA', owner: 'www', address: '2001:db8::1' },
        ]),
      )
      const www = await doc('www')
      assert.deepEqual(www.a, [{ ip: '1.1.1.1' }, { ttl: 60, ip: '1.1.1.2' }])
      assert.deepEqual(www.aaaa, [{ ip: '2001:db8::1' }])
    } finally {
      await p.disconnect()
    }
  })

  it('keeps labels relative to the zone', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      await p.publish(
        zoneMap([
          {
            id: 1,
            type: 'SRV',
            owner: '_sip._tcp',
            target: 'sip.r.example.',
            port: 5060,
          },
        ]),
      )
      assert.ok(await doc('_sip._tcp'), 'label stored without the zone suffix')
      assert.equal(await doc('_sip._tcp.r.example'), null)
    } finally {
      await p.disconnect()
    }
  })

  it('reports a type CoreDNS cannot serve instead of writing it', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      const artifacts = await p.publish(
        zoneMap([
          { id: 1, type: 'A', owner: '@', address: '1.2.3.4' },
          { id: 2, type: 'PTR', owner: 'rev', dname: 'x.r.example.' },
        ]),
      )
      assert.equal(artifacts.skipped.length, 1)
      assert.equal(artifacts.skipped[0].type, 'PTR')
      assert.equal(artifacts.recordCount, 1, 'only the servable record counted')
      assert.equal(await doc('rev'), null)
    } finally {
      await p.disconnect()
    }
  })

  it('replaces a zone rather than merging into it', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = publisher()
    try {
      await p.publish(
        zoneMap([
          { id: 1, type: 'A', owner: 'gone', address: '1.1.1.1' },
          { id: 2, type: 'A', owner: 'stays', address: '1.1.1.2' },
        ]),
      )
      await p.publish(zoneMap([{ id: 2, type: 'A', owner: 'stays', address: '9.9.9.9' }]))

      assert.equal(await doc('gone'), null, 'a deleted label must not survive')
      assert.deepEqual((await doc('stays')).a, [{ ip: '9.9.9.9' }])
    } finally {
      await p.disconnect()
    }
  })

  it('chunks a large zone across several HSETs', async (t) => {
    if (!reachable) return t.skip('no redis')
    const p = new CorednsRedisPublisher({
      address: ADDRESS,
      keyPrefix: PREFIX,
      chunkSize: 10,
    })
    try {
      const records = Array.from({ length: 55 }, (_, i) => ({
        id: i + 1,
        type: 'A',
        owner: `h${i}`,
        address: '1.2.3.4',
      }))
      const artifacts = await p.publish(zoneMap(records))
      assert.equal(artifacts.recordCount, 55)
      // 55 labels + the apex document.
      assert.equal(await probe.command('HLEN', `${PREFIX}r.example.`), 56)
    } finally {
      await p.disconnect()
    }
  })
})
