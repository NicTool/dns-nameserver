#!node

// import fs from 'node:fs/promises'
// const path = require('path')
// const os   = require('os')

// eslint-disable-next-line node/shebang
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


import zone     from 'dns-zone-validator'
import bind     from '../lib/bind.js'
import knot     from '../lib/knot.js'
import maradns  from '../lib/maradns.js'
import nsd      from '../lib/nsd.js'
import tinydns  from '../lib/tinydns.js'

const nsTypes = {
  bind,
  knot,
  maradns,
  nsd,
  tinydns,
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
      header    : 'NS Settings',
      optionList: usageOptions(),
      group     : 'main',
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
          example: './bin/nt-ns.js ',
        },
        {
          desc   : '2. ',
          example: './bin/nt-ns.js ',
        },
        {
          desc   : '3. ',
          example: './bin/nt-ns.js ',
        },
      ],
    },
    {
      content: 'Project home: {underline https://github.com/NicTool/dns-nameserver}',
    },
  ]
}


getZoneList()
  .then(r => {
    console.log(r)
    return r
  })
  .catch(e => {
    console.error(e)
  })

async function getZoneList () {
  const zoneList = await nsTypes[opts.import].getZones(opts.file, opts.base)
  for (const z in zoneList) {
    
  }
  return zoneList
}
