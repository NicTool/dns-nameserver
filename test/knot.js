
import assert from 'assert'
import fs     from 'fs/promises'

import { getZones, parseConfig } from '../lib/knot.js'


describe('knot', function () {

  describe('parseConfig', function () {

    it('parses v2 knot.conf', async () => {
      const file = './test/fixtures/knot/knotd-v2.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        server: [{ listen: [ '0.0.0.0@53', '::@53' ] }],
        zone  : [
          {
            domain : 'example.com',
            storage: '/var/lib/knot/zones/',
            file   : 'example.com.zone',
          },
        ],
        log: [{ target: 'syslog', any: 'info' }],
      })
    })

    it('parses v3 knot.conf', async () => {
      const file = './test/fixtures/knot/knotd-v3.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        server: [{ listen: [ '0.0.0.0@53' ,'::@53' ] }],
        zone  : [
          {
            domain : 'example.com',
            storage: '/var/lib/knot/zones/',
            file   : 'example.com.zone',
          },
        ],
        log: [{ target: 'syslog', any: 'info' }],
      })
    })

    it('parses knot-flex.conf', async () => {
      const file = './test/fixtures/knot/knot-flex.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepStrictEqual(r, {
        server: [{ listen: [ '0.0.0.0@53', '::@53' ] }],
        zone  : [
          {
            domain : 'example.com',
            storage: '/var/lib/knot/zones/',
            file   : 'example.com.zone',
          },
          { domain: 'example2.com', file: 'example2.com.zone' },
          { domain: 'example3.com', file: 'example3.com.zone' },
          { domain: 'example4.com', file: 'example4.com.zone' },
          { domain: 'example5.com', file: 'example5.com.zone' },
        ],
        log: [
          { target: 'syslog', any: 'info' },
          { target: '/var/log/knotd.log', any: 'info' },
        ],
      })
    })

    it('parses ns2.cadillac.net.conf', async () => {
      const file = './test/fixtures/knot/ns2.cadillac.net.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        zone: [
          {
            domain: '0.0.127.in-addr.arpa',
            file  : '/data/knot/0.0.127.in-addr.arpa',
          },
          {
            domain: '160/27.51.128.66.in-addr.arpa',
            file  : '/data/knot/160/27.51.128.66.in-addr.arpa',
          },
          { domain: 'horseshoeing.org', file: '/data/knot/horseshoeing.org' },
          { domain: 'txalamako.org', file: '/data/knot/txalamako.org' },
          { domain: 'theartfarm.com', file: '/data/knot/theartfarm.com' },
          {
            domain: '_report._dmarc.theartfarm.com',
            file  : '/data/knot/_report._dmarc.theartfarm.com',
          },
          { domain: 'w8ct.net', file: '/data/knot/w8ct.net' },
          { domain: 'tikismikis.org', file: '/data/knot/tikismikis.org' },
          { domain: 'lynboyer.com', file: '/data/knot/lynboyer.com' },
          {
            domain: '_tcp.theartfarm.com',
            file  : '/data/knot/_tcp.theartfarm.com',
          },
          { domain: 'horsenetwork.com', file: '/data/knot/horsenetwork.com' },
          { domain: 'ctacllc.com', file: '/data/knot/ctacllc.com' },
        ],
      })
    })
  })

  describe('getZones', function () {
    it('returns a list of zones', async () => {

      const filePath = './test/fixtures/knot/knot-flex.conf'
      const r = await getZones(filePath)
      // console.dir(r, { depth: null })
      const expected = new Map([
        [ 'example.com',  'example.com.zone' ],
        [ 'example2.com', 'example2.com.zone' ],
        [ 'example3.com', 'example3.com.zone' ],
        [ 'example4.com', 'example4.com.zone' ],
        [ 'example5.com', 'example5.com.zone' ],
      ])
      assert.deepStrictEqual(r, expected)
    })
  })
})
