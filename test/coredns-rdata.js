// Field names come from the plugin's types.go, not from coredns.io — that page
// documents ip4/ip6, priority and host where the structs say ip, preference and
// target. Publishing the documented spelling would unmarshal to zero values
// with no error reported anywhere, so these assertions are the guard.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COREDNS_TYPES,
  corednsRedisRdata,
  corednsRedisSoa,
} from '../lib/coredns-rdata.js'

const rdata = (rec, defaultTtl = 300) => corednsRedisRdata(rec, defaultTtl)

describe('corednsRedisRdata', () => {
  it('uses "ip" for A and AAAA, not ip4/ip6', () => {
    assert.deepEqual(rdata({ type: 'A', address: '1.2.3.4' }), {
      key: 'a',
      entry: { ip: '1.2.3.4' },
    })
    assert.deepEqual(rdata({ type: 'AAAA', address: '2001:db8::1' }), {
      key: 'aaaa',
      entry: { ip: '2001:db8::1' },
    })
  })

  it('uses "preference" for MX, not priority', () => {
    const { key, entry } = rdata({ type: 'MX', exchange: 'mail.a.com', preference: 20 })
    assert.equal(key, 'mx')
    assert.equal(entry.preference, 20)
    assert.equal(entry.priority, undefined)
    assert.equal(entry.host, 'mail.a.com.')
  })

  it('uses "target" for SRV, not host', () => {
    const { entry } = rdata({
      type: 'SRV',
      target: 'sip.a.com',
      port: 5060,
      priority: 10,
      weight: 20,
    })
    assert.deepEqual(entry, {
      priority: 10,
      weight: 20,
      port: 5060,
      target: 'sip.a.com.',
    })
    assert.equal(entry.host, undefined)
  })

  it('qualifies every name-valued field', () => {
    assert.equal(rdata({ type: 'CNAME', cname: 'www.a.com' }).entry.host, 'www.a.com.')
    assert.equal(rdata({ type: 'NS', dname: 'ns1.a.com' }).entry.host, 'ns1.a.com.')
  })

  it('omits ttl when it matches the zone default, since the tag is omitempty', () => {
    assert.equal(rdata({ type: 'A', address: '1.2.3.4', ttl: 300 }).entry.ttl, undefined)
    assert.equal(rdata({ type: 'A', address: '1.2.3.4', ttl: 60 }).entry.ttl, 60)
  })

  it('carries CAA through without a ttl field of its own', () => {
    const { entry } = rdata({ type: 'CAA', flags: 0, tag: 'issue', value: 'le.org' })
    assert.deepEqual(entry, { flag: 0, tag: 'issue', value: 'le.org' })
  })

  it('refuses a type CoreDNS cannot answer, naming it', () => {
    // Nine types, no PTR — so reverse zones cannot go here at all.
    assert.equal(COREDNS_TYPES.has('PTR'), false)
    assert.throws(() => rdata({ type: 'PTR', dname: 'x.a.com' }), /cannot serve PTR/)
    assert.throws(() => rdata({ type: 'DS' }), /cannot serve DS/)
  })
})

describe('corednsRedisSoa', () => {
  it('capitalizes MBox, as the struct tag does', () => {
    const soa = corednsRedisSoa({ mailaddr: 'hostmaster.a.com' }, 'a.com', [
      { type: 'NS', owner: '@', dname: 'ns1.a.com.' },
    ])
    assert.equal(soa.MBox, 'hostmaster.a.com.')
    assert.equal(soa.mbox, undefined)
    assert.equal(soa.ns, 'ns1.a.com.')
  })

  it('falls back to conventional names when the zone row is bare', () => {
    const soa = corednsRedisSoa({}, 'a.com', [])
    assert.equal(soa.ns, 'ns1.a.com.')
    assert.equal(soa.MBox, 'hostmaster.a.com.')
    assert.equal(soa.refresh, 86400)
    assert.equal(soa.minttl, 3600)
  })
})
