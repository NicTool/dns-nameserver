
import assert from 'assert'
import fs     from 'fs/promises'

import { getZones, parseConfig } from '../lib/maradns.js'

describe('maradns', function () {

  describe('parseConfig', function () {

    it('parses mararc', async () => {
      const file = './test/fixtures/maradns/mararc'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        chroot_dir         : '/etc/maradns',
        csv2               : '{}',
        ipv4_bind_addresses: '127.0.0.1',
        maradns_uid        : 99,
        max_ar_chain       : 1,
        max_chain          : 8,
        max_total          : 20,
        no_fingerprint     : 0,
        verbose_level      : 1,
      })
    })

    it('parses example.com mararc', async () => {
      const file = './test/fixtures/maradns/example.com'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        'csv2["example.com."]' : 'db.example.com',
        'csv2["example2.com."]': 'db.example2.com',
        chroot_dir             : '/etc/maradns',
        csv2                   : '{}',
        ipv4_bind_addresses    : '10.1.2.3,10.1.2.4,127.0.0.1',
        maradns_gid            : 99,
        maradns_uid            : 99,
        max_ar_chain           : 1,
        max_chain              : 8,
        max_total              : 20,
        no_fingerprint         : 0,
        verbose_level          : 3,
        zone_transfer_acl      : '10.1.1.1/24, 10.100.100.100/255.255.255.224',
      })
    })
  })

  describe('getZones', function () {
    it('returns a list of zones', async () => {

      const filePath = './test/fixtures/maradns/example.com'
      const r = await getZones(filePath)
      // console.dir(r, { depth: null })
      const expected = new Map([
        [ 'example.com.', 'db.example.com' ],
        [ 'example2.com.', 'db.example2.com' ],
      ])
      assert.deepStrictEqual(r, expected)
    })
  })
})
