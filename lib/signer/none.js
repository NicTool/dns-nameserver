import Signer from './base.js'

export class NoneSigner extends Signer {
  async sign(artifacts) {
    return artifacts
  }
}

export default NoneSigner
