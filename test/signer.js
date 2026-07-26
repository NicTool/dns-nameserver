import assert from 'node:assert'
import { describe, it } from 'node:test'

import NoneSigner from '../lib/signer/none.js'
import MemorySigner from '../lib/signer/memory.js'
import Rfc1035Signer from '../lib/signer/rfc1035.js'

describe('Signer', function () {
  it('NoneSigner passes artifacts through unchanged', async () => {
    const s = new NoneSigner()
    const art = { foo: 1 }
    assert.strictEqual(await s.sign(art), art)
  })

  it('MemorySigner throws a clear not-yet-implemented error', async () => {
    await assert.rejects(() => new MemorySigner({}).sign({}), /not yet implemented/)
  })

  it('Rfc1035Signer throws a clear not-yet-implemented error', async () => {
    await assert.rejects(() => new Rfc1035Signer({}).sign({}), /not yet implemented/)
  })
})
