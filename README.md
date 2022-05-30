# dns-nameserver

Nameserver configuration parsers and generators


## SYNOPSIS

Name servers have configuration files, each with their own format. This package abstracts the unique implementations into a set of common actions.


### nt-ns.js

````
✗ ./bin/nt-ns.js -h

 +-+-+-+ +-+-+-+-+-+-+-+-+-+-+
 |D|N|S| |N|A|M|E|S|E|R|V|E|R|
 +-+-+-+ +-+-+-+-+-+-+-+-+-+-+

I/O

  -i, --import <bind | knot | maradns | nsd | tinydns>   nameserver type
  -e, --export <bind | knot | maradns | nsd | tinydns>   nameserver type
  -f, --file <file path>                                 source of DNS server config file
  -b, --base <zones dir>                                 path prefix for zone files

Misc

  -v, --verbose    Show status messages during processing
  -h, --help       Display this usage guide

Examples

  1.    ./bin/nt-ns.js -i knot -f ./knot/knot.conf
  2.    ./bin/nt-ns.js -i bind -f ./bind/named.conf -b bind
  3.    ./bin/nt-ns.js -i nsd -f ./nsd/nsd.conf -b nsd -v

  Project home: https://github.com/NicTool/dns-nameserver
````


## FUNCTIONS

### getZones

Returns a list of zones (and zone files) from the specified nameserver config file.


### parseConfig

Does the heavy lifting for `getZones`. Accepts and string and returns an object where the keys are DNS zones and the value is a the file with that zones resource records.


## FEATURES

- config parsers for bind, nsd, knot, maradns, and tinydns


## TODO

- [ ] config generator
    - [ ] bind
    - [ ] nsd
    - [ ] knot
    - [ ] maradns
    - [ ] tinydns
    - [ ] powerdns ([#30](https://github.com/msimerson/NicTool/issues/30))


## SEE ALSO

- [Dictionary of DNS terms](https://nictool.github.io/web/Dictionary)
- [Wikipedia, DNS Server Software](https://en.wikipedia.org/wiki/Comparison_of_DNS_server_software)


## DEVELOP

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  + fix, feature, BREAKING CHANGE, build, chore, ci, docs, style, test
- [keep a changelog](https://keepachangelog.com/)
- [sentimental versioning](http://sentimentalversioning.org)

[![Module Tests](https://github.com/NicTool/dns-nameserver/actions/workflows/ci.yml/badge.svg)](https://github.com/NicTool/dns-nameserver/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/NicTool/dns-nameserver/badge.svg?branch=master)](https://coveralls.io/github/NicTool/dns-nameserver?branch=master)
