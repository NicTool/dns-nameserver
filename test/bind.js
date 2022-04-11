
import assert from 'assert'
import fs     from 'fs/promises'

import { getZones, parseConfig } from '../lib/bind.js'


describe('bind', function () {

  describe('parseConfig', function () {

    it('parses named.conf file', async () => {
      const file = './test/fixtures/bind/named.conf-ztrax-master'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepStrictEqual(r, {
        options: {
          directory        : '/var/named',
          version          : 'get lost',
          'allow-transfer' : '{"none";}',
          'allow-recursion': '{192.168.3.0/24;}',
        },
        logging: {
          'channel example_log': {
            file            : '"/var/log/named/example.log" versions 3 size 2m',
            severity        : 'info',
            'print-severity': 'yes',
            'print-time'    : 'yes',
            'print-category': 'yes',
          },
          'category default': { example_log: '' },
        },
        zone: [
          { name: '.', type: 'hint', file: 'root.servers' },
          {
            name            : 'example.com',
            type            : 'master',
            file            : 'master/master.example.com',
            'allow-transfer': '{192.168.23.1;192.168.23.2;}',
          },
          {
            name                 : 'localhost',
            type                 : 'master',
            file                 : 'master.localhost',
            'allow-update{none;}': '',
          },
          {
            name                 : '0.0.127.in-addr.arpa',
            type                 : 'master',
            file                 : 'localhost.rev',
            'allow-update{none;}': '',
          },
          {
            name: '0.168.192.IN-ADDR.ARPA',
            type: 'master',
            file: '192.168.0.rev',
          },
        ],
      })
    })
  })

  describe('getZones', function () {
    it('returns a list of zones', async () => {

      const filePath = './test/fixtures/bind/named.conf-ztrax-master'
      const r = await getZones(filePath)
      // console.dir(r, { depth: null })
      const expected = new Map([
        [ '.' , 'root.servers' ],
        [ 'example.com' , 'master/master.example.com' ],
        [ 'localhost' , 'master.localhost' ],
        [ '0.0.127.in-addr.arpa' , 'localhost.rev' ],
        [ '0.168.192.in-addr.arpa' , '192.168.0.rev' ],
      ])
      assert.deepStrictEqual(r, expected)
    })
  })
})
