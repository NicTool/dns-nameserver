
import assert from 'assert'
import path   from 'path'
import os     from 'os'

import * as index from '../index.js'

import * as tinydns from '../lib/tinydns.js'

describe('index', function () {
  describe('fullPath', function () {
    it('does nothing when base is undefined', async () => {
      assert.strictEqual(
        index.fullPath(undefined, 'zones/example.com'),
        'zones/example.com'
      )
    })

    it('does nothing when base is empty', async () => {
      assert.strictEqual(
        index.fullPath('', 'zones/example.com'),
        'zones/example.com'
      )
    })

    it('resolves a zone file into base', async () => {
      // have to do this with path for windows compat
      const pathBits = [ 'test', 'base', 'example.com' ]
      pathBits.unshift(os.platform === 'win32' ? 'D:' : '/')

      assert.strictEqual(
        index.fullPath('/test/base', 'zones/example.com'),
        path.join(...pathBits)
      )
    })
  })

  describe('isDelegated', function () {
    it('verifies a zone delegation exists', async function () {
      const r = await index.isDelegated('cadillac.net', [ 'ns1.cadillac.net' ])
      assert.strictEqual(r, true)
    })

    it('verifies a lacking zone delegation', async function () {
      const r = await index.isDelegated('cadillac.net', [ 'ns1.cadilac.net' ])
      assert.strictEqual(r, false)
    })
  })

  describe.skip('isDelegated', function () {
    this.timeout(50000)
    it('generates SQL to remove stale/invalid delegation', async function () {
      const zones = await tinydns.getZones('ignore/tinydns/data-ns2.cadillac')
      // console.log(zones)
      for (const z of zones.keys()) {
        const r = await index.isDelegated(z, [ 'ns2.cadillac.net' ])
        if (r) {
          console.log(`ok, ${z}`)
        }
        else {
          console.log(`NOT, ${z}`)
          // console.log(`DELETE FROM nt_zone_nameserver AS ns LEFT JOIN nt_zone z WHERE z.nt_zone=${z} AND nt_zone_nameserver=4`)
        }
      }
    })
  })
})
