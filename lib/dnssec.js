import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * DNSSEC, done with whatever each nameserver already ships.
 *
 * Wherever a tool exists, NicTool defers to it: those tools have solved key
 * rollover, timers and NSEC3 opt-out. The one exception is native, which is not
 * a separate server and so has nothing to defer to.
 *
 *   signer  — the zone files are signed here, with BIND's dnssec-signzone,
 *             before the transport ships them. bind and nsd both read the
 *             result; nsd has no signer of its own, and CoreDNS's `file`
 *             plugin serves a signed zone as readily as an unsigned one.
 *   self    — the server signs, and NicTool's job is to say so in the config
 *             it generates. Knot manages its own keys through KASP; PowerDNS
 *             signs from key material in its database.
 *   memory  — native, which answers from this process. MemorySigner signs the
 *             live zone map with node's crypto, over rdata from
 *             @nictool/dns-resource-record, and reads the same BIND-format
 *             keyset as the file signer. NSEC only; it refuses NSEC3.
 *   none    — no tool and no way to add one: djbdns and MaraDNS have no DNSSEC.
 */
export const DNSSEC_STRATEGY = {
  bind: 'signer',
  nsd: 'signer',
  coredns: 'signer',
  knot: 'self',
  powerdns: 'self',
  native: 'memory',
  djbdns: 'none',
  maradns: 'none',
}

/** dnssec-keygen's own spellings, which the API schema already uses. */
export const ALGORITHMS = [
  'RSASHA256',
  'RSASHA512',
  'ECDSAP256SHA256',
  'ECDSAP384SHA384',
  'ED25519',
  'ED448',
]

export const DEFAULT_ALGORITHM = 'ECDSAP256SHA256'

export function strategyFor(type) {
  return DNSSEC_STRATEGY[type] ?? 'none'
}

export function assertAlgorithm(algorithm) {
  const algo = algorithm || DEFAULT_ALGORITHM
  if (!ALGORITHMS.includes(algo)) {
    throw new Error(`DNSSEC: unsupported algorithm "${algorithm}"`)
  }
  return algo
}

/** Key files BIND writes are K<zone>.+<alg>+<tag>.{key,private}. */
const keyPattern = (zone) => new RegExp(`^K${escapeRe(zone)}\\.\\+\\d+\\+\\d+\\.key$`)

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function existingKeys(keyDir, zone) {
  try {
    const entries = await fs.readdir(keyDir)
    return entries.filter((f) => keyPattern(zone).test(f))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * Make sure the zone has a KSK and a ZSK, generating them if not.
 *
 * Generation is skipped whenever any key exists: re-keying on a schedule is
 * rollover, which belongs to whoever operates the zone, not to a publish cycle
 * that runs every few minutes.
 */
export async function ensureKeys({
  keyDir,
  zone,
  algorithm = DEFAULT_ALGORITHM,
  keygen = 'dnssec-keygen',
}) {
  const algo = assertAlgorithm(algorithm)
  const found = await existingKeys(keyDir, zone)
  if (found.length) return { created: [], existing: found }

  await fs.mkdir(keyDir, { recursive: true })
  const created = []
  for (const args of [
    ['-a', algo, '-K', keyDir, '-n', 'ZONE', zone],
    ['-a', algo, '-K', keyDir, '-f', 'KSK', '-n', 'ZONE', zone],
  ]) {
    const { stdout } = await run(keygen, ['-q', ...args], `generate a key for ${zone}`)
    created.push(stdout.trim())
  }
  return { created, existing: [] }
}

/**
 * Sign one zone file in place: dnssec-signzone writes beside the input, and the
 * result is renamed over it so the generated server config — which named the
 * unsigned file — keeps pointing at something valid.
 */
export async function signZoneFile({
  zone,
  file,
  keyDir,
  nsec3 = false,
  salt = null,
  signzone = 'dnssec-signzone',
}) {
  const dir = path.dirname(file)
  const out = `${file}.signing`

  const args = ['-S', '-K', keyDir, '-d', dir, '-o', zone, '-f', out]
  // A zone with NSEC3 needs a salt; "-" means none, which is what RFC 9276
  // recommends now that opt-out salting bought nothing.
  if (nsec3) args.push('-3', salt || '-')
  args.push(file)

  await run(signzone, args, `sign ${zone}`)
  await fs.rename(out, file)
  return file
}

async function run(bin, args, what) {
  try {
    return await execFileAsync(bin, args)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `DNSSEC: ${bin} not found — install it, or point at it with dnssec.tools`,
        { cause: err },
      )
    }
    const detail = String(err.stderr || err.message)
      .split('\n')
      .filter(Boolean)
      .slice(-3)
      .join('; ')
    throw new Error(`DNSSEC: failed to ${what}: ${detail}`, { cause: err })
  }
}

export default { DNSSEC_STRATEGY, strategyFor, ensureKeys, signZoneFile }
