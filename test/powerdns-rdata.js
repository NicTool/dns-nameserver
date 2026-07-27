// The NicTool -> PowerDNS rdata mapping, shared by the gmysql publisher and
// the nt-powerdns pipe backend. PowerDNS keeps MX/SRV priority out of the
// rdata — a column in one, its own protocol field in the other — so the split
// has to be identical for both.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { powerdnsRdata, powerdnsSoa } from '../lib/powerdns-rdata.js'

describe('powerdnsRdata', () => {
  it('leaves ordinary types alone, with no priority', () => {
    assert.deepEqual(powerdnsRdata({ type: 'A', address: '192.0.2.1' }), {
      content: '192.0.2.1',
      prio: null,
    })
  })

  it('splits the MX preference out of the rdata', () => {
    // NicTool keeps the MX preference in `weight`.
    assert.deepEqual(
      powerdnsRdata({ type: 'MX', exchange: 'mail.example.com.', preference: 10 }),
      {
        content: 'mail.example.com',
        prio: 10,
      },
    )
  })

  it('builds SRV rdata as "weight port target" with priority split out', () => {
    const rr = {
      type: 'SRV',
      target: 'sip.example.com.',
      priority: 20,
      weight: 10,
      port: 5060,
    }

    assert.deepEqual(powerdnsRdata(rr), { content: '10 5060 sip.example.com', prio: 20 })
  })

  it('takes the SRV port from `port` when a source already mapped it', () => {
    const rr = {
      type: 'SRV',
      target: 'sip.example.com.',
      priority: 1,
      weight: 2,
      port: 5061,
    }

    assert.equal(powerdnsRdata(rr).content, '2 5061 sip.example.com')
  })

  it('strips the trailing dot from name-valued rdata', () => {
    assert.equal(
      powerdnsRdata({ type: 'CNAME', cname: 'www.example.com.' }).content,
      'www.example.com',
    )
    assert.equal(
      powerdnsRdata({ type: 'NS', dname: 'ns1.example.com.' }).content,
      'ns1.example.com',
    )
  })

  it('keeps free-form rdata verbatim, dots and case included', () => {
    // A TXT value may legitimately end in a dot, and its case is significant.
    const txt = { type: 'TXT', data: 'v=spf1 include:_spf.Example.COM -all.' }

    // PowerDNS stores TXT content quoted, as the presentation format has it.
    assert.equal(powerdnsRdata(txt).content, '"v=spf1 include:_spf.Example.COM -all."')
  })

  it('rejects a record the library cannot build, rather than emitting junk', () => {
    // The publishers catch this and comment out the one record.
    assert.throws(() => powerdnsRdata({ type: 'A' }), /address is required/)
    assert.throws(() => powerdnsRdata({ type: 'NOSUCHTYPE' }), /unsupported record type/)
  })
})

describe('powerdnsSoa', () => {
  it('renders the seven SOA fields in order', () => {
    // mailaddr is the RNAME; the MNAME comes from the zone's apex NS record.
    const zone = {
      mailaddr: 'hostmaster.example.com.',
      serial: 42,
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minimum: 3600,
    }

    const records = [{ owner: '@', type: 'NS', dname: 'ns1.example.com.' }]

    assert.equal(
      powerdnsSoa(zone, 'example.com', records),
      'ns1.example.com hostmaster.example.com 42 7200 3600 1209600 3600',
    )
  })

  it('defaults the RNAME to hostmaster when mailaddr is unset', () => {
    const records = [{ owner: '@', type: 'NS', dname: 'ns9.example.com.' }]

    assert.equal(
      powerdnsSoa({ serial: 1 }, 'example.com', records).split(' ').slice(0, 2).join(' '),
      'ns9.example.com hostmaster.example.com',
    )
  })

  it('never puts mailaddr in the MNAME slot', () => {
    // The pre-v3 code used mailaddr as the primary nameserver, which put the
    // responsible-person address where the primary NS belongs.
    const soa = powerdnsSoa({ mailaddr: 'hostmaster.example.com.' }, 'example.com', [])

    assert.equal(soa.split(' ')[0], 'ns1.example.com', 'falls back to ns1, not mailaddr')
  })

  it('falls back to conventional names and timers when the zone is sparse', () => {
    assert.equal(
      powerdnsSoa({}, 'example.com'),
      'ns1.example.com hostmaster.example.com 1 86400 7200 1209600 3600',
    )
  })
})
