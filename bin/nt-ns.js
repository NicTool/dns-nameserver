#!node

// eslint-disable-next-line node/shebang
import fs from 'fs/promises'
import os from 'os'

import chalk from 'chalk'
import cmdLineArgs from 'command-line-args'
import cmdLineUsage from 'command-line-usage'

function usage () {
  console.error(cmdLineUsage(usageSections()))
  // eslint-disable-next-line no-process-exit
  process.exit(1)
}

// CLI argument processing
const opts = cmdLineArgs(usageOptions())._all
if (opts.verbose) console.error(opts)
if (opts.help) usage()
if (!opts.import) usage()
if (!opts.file) usage()


import * as zone from 'dns-zone-validator'
import bind      from '../lib/bind.js'
import knot      from '../lib/knot.js'
import maradns   from '../lib/maradns.js'
import nsd       from '../lib/nsd.js'
import tinydns   from '../lib/tinydns.js'

const nsTypes = {
  bind,
  knot,
  maradns,
  nsd,
}

// zone file format, most DNS servers use RFC 103[4|5] format
let zfType = 'bind'    // BIND, Knot, NSD, PowerDNS, etc.
switch (opts.import) {
  case 'tinydns':
    zfType = 'tinydns'
    break
  case 'maradns':
    zfType = 'maradns'
    break
}

function usageOptions () {
  return [
    {
      name       : 'import',
      alias      : 'i',
      type       : String,
      typeLabel  : '<bind | knot | maradns | nsd | tinydns>',
      description: 'nameserver type',
      group      : 'io',
    },
    {
      name       : 'export',
      alias      : 'e',
      type       : String,
      typeLabel  : '<bind | knot | maradns | nsd | tinydns>',
      description: 'nameserver type',
      group      : 'io',
    },
    {
      name       : 'file',
      alias      : 'f',
      type       : String,
      typeLabel  : '<file path>',
      description: 'source of DNS server config file',
      group      : 'io',
    },
    {
      name       : 'base',
      alias      : 'b',
      type       : String,
      typeLabel  : '<zones dir>',
      description: 'path prefix for zone files',
      group      : 'io',
    },
    {
      name       : 'verbose',
      alias      : 'v',
      description: 'Show status messages during processing',
      type       : Boolean,
    },
    {
      name       : 'help',
      description: 'Display this usage guide',
      alias      : 'h',
      type       : Boolean,
    },
  ]
}

function usageSections () {
  return [
    {
      content: chalk.blue(` +-+-+-+ +-+-+-+-+-+-+-+-+-+-+\n |D|N|S| |N|A|M|E|S|E|R|V|E|R|\n +-+-+-+ +-+-+-+-+-+-+-+-+-+-+`),
      raw    : true,
    },
    {
      header    : 'I/O',
      optionList: usageOptions(),
      group     : 'io',
    },
    {
      header    : 'Misc',
      optionList: usageOptions(),
      group     : '_none',
    },
    {
      header : 'Examples',
      content: [
        {
          desc   : '1. ',
          example: './bin/nt-ns.js -i knot -f ./knot/knot.conf',
        },
        {
          desc   : '2. ',
          example: './bin/nt-ns.js -i bind -f ./bind/named.conf -b bind',
        },
        {
          desc   : '3. ',
          example: './bin/nt-ns.js -i nsd -f ./nsd/nsd.conf -b nsd -v',
        },
      ],
    },
    {
      content: 'Project home: {underline https://github.com/NicTool/dns-nameserver}',
    },
  ]
}

if (opts.import === 'tinydns') {
  getTinyZones().catch(console.error)
}
else {
  getZoneList().catch(console.error)
}

async function getZoneList () {
  const zoneList = await nsTypes[opts.import].getZones(opts.file, opts.base)
  for (const z of zoneList) {
    const [ origin, filePath ] = z
    const buf = await fs.readFile(filePath)
    const rrs = await zone[ zfType ].parseZoneFile(buf.toString())
    console.log(`OK, ${origin} has ${rrs.length - 2} RRs`)
    if (opts.verbose) console.log(rrs)
  }
  return zoneList
}

async function getTinyZones () {
  const zones = await tinydns.getZones(opts.file)

  for (const name of zones.keys()) {
    const lines = await tinydns.getZone(opts.file, name)
    if (opts.verbose) console.log(lines)
    zone.tinydns.zoneOpts.serial = await zone.serialByFileStat(opts.file)
    const r = await zone.tinydns.parseData(lines.join(os.EOL))
    console.log(`OK, ${name} has ${r.length} RRs`)
  }

  return zones
}