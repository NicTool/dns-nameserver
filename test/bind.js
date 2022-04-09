
const assert = require('assert')
const fs     = require('fs').promises

const ns = require('../lib/bind.js')


describe('bind', function () {

  describe('parseConfig', function () {

    it('parses named.conf file', async () => {
      const file = './test/fixtures/bind/named.conf-ztrax-master'
      const buf = await fs.readFile(file)

      const r = await ns.parseConfig(buf.toString())
      // console.dir(r, { depth: null })
      assert.equal(r.length, 5)
    })
  })

})
