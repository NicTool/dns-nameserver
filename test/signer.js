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

  // MemorySigner is exercised properly in test/signer-memory.js, against keys
  // it can actually sign with. This only pins the case where no publisher is
  // attached, which must not be mistaken for a zone with nothing to sign.
  it('MemorySigner passes through when no publisher is attached', async () => {
    const artifacts = { kind: 'memory' }
    assert.strictEqual(await new MemorySigner({}).sign(artifacts), artifacts)
  })

  // Rfc1035Signer is exercised properly in test/dnssec.js, against the real
  // dnssec-signzone. This only pins the no-zones case, which needs no tooling.
  it('Rfc1035Signer passes through when there are no zone files', async () => {
    const artifacts = { kind: 'rfc1035', files: [] }
    assert.strictEqual(await new Rfc1035Signer({}).sign(artifacts), artifacts)
  })
})
