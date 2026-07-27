// Shared zone assembly: NicTool's storage shape -> resource records.
//
// Every zone-file publisher goes through this, so the SOA synthesis and the
// deleted/SOA skipping are tested once here rather than three times over.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { zoneToRRs } from '../lib/zone-rrs.js'

const ZONE = 'assembly.test'
const zone = {
  zone: ZONE,
  ttl: 300,
  serial: 7,
  mailaddr: `hostmaster.${ZONE}.`,
  refresh: 7200,
  retry: 3600,
  expire: 1209600,
  minimum: 3600,
}
const NS = { owner: '@', type: 'NS', dname: `ns1.${ZONE}.` }

const build = (records, z = zone, name = ZONE) => zoneToRRs(name, z, records)
const soaOf = (result) => result.rrs[0]

describe('zoneToRRs', () => {
  it('puts a synthesized SOA first, since NicTool keeps it on the zone row', () => {
    const soa = soaOf(build([NS]))

    assert.equal(soa.get('type'), 'SOA')
    assert.equal(soa.get('owner'), `${ZONE}.`)
    assert.equal(soa.get('serial'), 7)
  })

  it('takes MNAME from the apex NS and RNAME from mailaddr', () => {
    // Not the other way round: Export/BIND.pm is `SOA nsname mailaddr`.
    const soa = soaOf(build([NS]))

    assert.equal(soa.get('mname'), `ns1.${ZONE}.`)
    assert.equal(soa.get('rname'), `hostmaster.${ZONE}.`)
  })

  it('accepts the zone name with or without a trailing dot', () => {
    assert.equal(build([NS], zone, `${ZONE}.`).apex, ZONE)
    assert.equal(build([NS], zone, ZONE).apex, ZONE)
  })

  it('qualifies every owner against the apex', () => {
    const { rrs } = build([NS, { owner: 'www', type: 'A', address: '192.0.2.1' }])

    assert.deepEqual(
      rrs.map((r) => r.get('owner')),
      [`${ZONE}.`, `${ZONE}.`, `www.${ZONE}.`],
    )
  })

  it('skips soft-deleted records', () => {
    const { rrs } = build([
      NS,
      { owner: 'gone', type: 'A', address: '192.0.2.9', deleted: 1 },
    ])

    assert.equal(rrs.length, 2)
  })

  it('skips a stored SOA, which the zone row already supplied', () => {
    const { rrs } = build([NS, { owner: '@', type: 'SOA', address: 'x' }])

    assert.equal(rrs.filter((r) => r.get('type') === 'SOA').length, 1)
  })

  it('reports an unbuildable record instead of failing the zone', () => {
    const { rrs, errors } = build([
      NS,
      { owner: 'bad', type: 'NOSUCHTYPE', address: 'x' },
    ])

    assert.equal(rrs.length, 2, 'the good records survive')
    assert.deepEqual(
      errors.map((e) => [e.owner, e.type]),
      [[`bad.${ZONE}.`, 'NOSUCHTYPE']],
    )
    assert.match(errors[0].message, /unsupported record type/)
    assert.doesNotMatch(errors[0].message, /\n/, 'one line, for a zone-file comment')
  })

  it('falls back to defaults when the zone row omits them', () => {
    const soa = soaOf(build([NS], { zone: ZONE }))

    assert.equal(soa.get('ttl'), 3600)
    assert.equal(soa.get('serial'), 1)
    assert.equal(soa.get('refresh'), 86400)
    assert.equal(soa.get('minimum'), 3600)
    assert.equal(soa.get('mname'), `ns1.${ZONE}.`, 'the apex NS, still')
  })

  it('falls back when a numeric column holds something unusable', () => {
    // MySQL will not produce this, but a hand-edited file store can.
    assert.equal(soaOf(build([NS], { ...zone, serial: 'nonsense' })).get('serial'), 1)
  })

  it('gives a record its own TTL, and the zone default otherwise', () => {
    const { rrs } = build([
      NS,
      { owner: 'slow', type: 'A', address: '192.0.2.1', ttl: 86400 },
      { owner: 'plain', type: 'A', address: '192.0.2.2' },
    ])

    assert.equal(rrs[2].get('ttl'), 86400)
    assert.equal(rrs[3].get('ttl'), 300)
  })
})
