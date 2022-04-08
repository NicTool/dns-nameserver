
const assert = require('assert')
const fs     = require('fs').promises

const ns = require('../index.js')


describe('parseBindConfig', function () {

  it('parses named.conf file', async () => {
    const file = './test/fixtures/bind/named.conf-ztrax-master'
    const buf = await fs.readFile(file)

    const r = await ns.parseBindConfig(buf.toString())
    // console.dir(r, { depth: null })
    assert.equal(r.length, 5)
  })
})


