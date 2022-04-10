
import assert from 'assert'
import fs     from 'fs/promises'

import { parseConfig } from '../lib/nsd.js'


describe('nsd', function () {

  describe('parseConfig', function () {

    it('parses nsd.conf', async () => {
      const file = './test/fixtures/nsd/nsd.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        server: [
          {
            'server-count': 1,
            database      : '',
            zonelistfile  : '/var/db/nsd/zone.list',
            username      : 'nsd',
            logfile       : '/var/log/nsd.log',
            pidfile       : '/var/run/nsd.pid',
            xfrdfile      : '/var/db/nsd/xfrd.state',
          },
        ],
        zone: [
          { name: 'example.com', zonefile: '/etc/nsd/example.com.zone' },
          {
            name         : 'masterzone.com',
            zonefile     : '/etc/nsd/masterzone.com.zone',
            notify       : '192.0.2.1 NOKEY',
            'provide-xfr': '192.0.2.1 NOKEY',
          },
          {
            name          : 'secondzone.com',
            zonefile      : '/etc/nsd/secondzone.com.zone',
            'allow-notify': '192.0.2.2 NOKEY',
            'request-xfr' : '192.0.2.2 NOKEY',
          },
        ],
      })
    })

    it('parses example.com', async () => {
      const file = './test/fixtures/nsd/example.com'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        server: [
          {
            'server-count': 1,
            database      : '',
            logfile       : '/var/log/nsd.log',
            pidfile       : '/var/run/nsd.pid',
            username      : 'nsd',
          },
        ],
        'remote-control': [
          {
            'control-cert-file': '/etc/nsd/nsd_control.pem',
            'control-enable'   : 'yes',
            'control-interface': '127.0.0.1',
            'control-key-file' : '/etc/nsd/nsd_control.key',
            'server-cert-file' : '/etc/nsd/nsd_server.pem',
            'server-key-file'  : '/etc/nsd/nsd_server.key',
          },
        ],
        zone: [
          {
            name    : 'example.com',
            zonefile: '/etc/nsd/example.com.zone',
          },
        ],
      })
    })

    it('parses ns3.cadillac.net.conf', async () => {
      const file = './test/fixtures/nsd/ns2.cadillac.net.conf'
      const buf = await fs.readFile(file)

      const r = await parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.deepEqual(r, {
        zone: [
          {
            name    : 'emeraldparadise.realty',
            zonefile: '/data/nsd/emeraldparadise.realty',
          },
          { name: 'virus.realty', zonefile: '/data/nsd/virus.realty' },
          {
            name    : 'insanangelotx.realty',
            zonefile: '/data/nsd/insanangelotx.realty',
          },
          {
            name    : 'bluehawaii.realty',
            zonefile: '/data/nsd/bluehawaii.realty',
          },
          { name: 'iz.feedback', zonefile: '/data/nsd/iz.feedback' },
          { name: 'raveis.realty', zonefile: '/data/nsd/raveis.realty' },
        ],
      })
    })
  })
})
