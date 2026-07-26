import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import Transport from './base.js'

const execFileAsync = promisify(execFile)

/**
 * RsyncTransport – pushes published zone files to a remote host via rsync
 * over ssh. Expects artifacts from Rfc1035Publisher (or any publisher that
 * writes to a directory and returns `{ directory, files }`).
 */
export class RsyncTransport extends Transport {
  constructor({ remote, sshKey = null, interval = 300, cooldown = 5 } = {}) {
    super({ interval, cooldown })
    if (!remote)
      throw new Error('RsyncTransport: remote is required (e.g. "user@host:/path")')
    this.remote = remote
    this.sshKey = sshKey
  }

  async deliver(artifacts) {
    const src = artifacts?.directory
    if (!src) return { ok: false, skipped: 'no directory in artifacts' }

    const sshCmd = this.sshKey ? `ssh -i ${shellQuote(this.sshKey)}` : 'ssh'
    const args = ['-az', '--delete', '-e', sshCmd, '--', src + '/', this.remote]
    const { stdout, stderr } = await execFileAsync('rsync', args)
    return { ok: true, remote: this.remote, stdout, stderr }
  }
}

// rsync passes -e to a shell, so the key path has to survive that hop intact.
function shellQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`
}

export default RsyncTransport
