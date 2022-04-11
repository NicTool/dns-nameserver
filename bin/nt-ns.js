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


function usageOptions () {
  return [
    {
      name        : 'import',
      alias       : 'i',
      defaultValue: 'bind',
      type        : String,
      typeLabel   : '<bind | knot | maradns | nsd | tinydns>',
      description : 'nameserver type',
      group       : 'io',
    },
    {
      name        : 'export',
      alias       : 'e',
      defaultValue: 'js',
      type        : String,
      typeLabel   : '<bind | knot | maradns | nsd | tinydns>',
      description : 'nameserver type',
      group       : 'io',
    },
    {
      name       : 'file',
      alias      : 'f',
      // defaultValue: '',
      type       : String,
      typeLabel  : '<file path>',
      description: 'source of DNS server config file',
      group      : 'io',
    },
    {
      name       : 'base',
      alias      : 'b',
      // defaultValue: '',
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
