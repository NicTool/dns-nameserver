
import assert from 'assert'

import { fullPath, valueCleanup } from '../index.js'


describe('index', function () {
  describe('fullPath', function () {
    it('does nothing when base is undefined', async () => {
      assert.strictEqual(
        fullPath(undefined, 'zones/example.com'),
        'zones/example.com'
      )
    })

    it('does nothing when base is empty', async () => {
      assert.strictEqual(
        fullPath('', 'zones/example.com'),
        'zones/example.com'
      )
    })

    it('resolves a zone file into base', async () => {
      assert.strictEqual(
        fullPath('/test/base', 'zones/example.com'),
        '/test/base/example.com'
      )
    })
  })
})
