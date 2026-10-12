# dns-nameserver

Nameserver configuration parsers and generators

## SYNOPSIS

Name servers have configuration files, and each has its own config file format. This package abstracts the unique implementations into a set of common actions.

### nt-ns.js

```
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
```

### nt-powerdns

A PowerDNS pipe/co-process backend. PowerDNS forks it and asks it a question at
a time over stdin/stdout, and it answers from the NicTool database directly, so
there is nothing to publish and nothing to go stale.

Configured from the environment, because PowerDNS gives a `pipe-command` no
arguments of its own:

| variable            | default     |                                   |
| ------------------- | ----------- | --------------------------------- |
| `NT_PDNS_DB_HOST`   | `127.0.0.1` |                                   |
| `NT_PDNS_DB_PORT`   | `3306`      |                                   |
| `NT_PDNS_DB_USER`   | `nictool`   |                                   |
| `NT_PDNS_DB_PASS`   | —           | required                          |
| `NT_PDNS_DB_NAME`   | `nictool`   |                                   |
| `NT_PDNS_NS_ID`     | `1`         | which nameserver's zones to serve |
| `NT_PDNS_LOG`       | —           | `1` for verbose stderr logging    |
| `NT_PDNS_CACHE_TTL` | `20`        | seconds to cache a query result   |

In `pdns.conf`:

```
launch=pipe
pipe-command=/path/to/node_modules/.bin/nt-powerdns
pipe-abi-version=1
```

## ARCHITECTURE

A nameserver is composed from five kinds of part:

| type          | role                                                     |
| ------------- | -------------------------------------------------------- |
| **Source**    | reads NicTool's zone truth (`FileSource`, `MysqlSource`) |
| **Publisher** | writes that truth out as artifacts a nameserver serves   |
| **Signer**    | signs the published zones                                |
| **Transport** | moves the artifacts to where the nameserver reads them   |
| **Backend**   | answers queries live, instead of publishing anything     |

`Publisher` and `Backend` are the two ways to get NicTool data into a
nameserver, and PowerDNS is the one engine that supports both:
`PowerdnsDbPublisher` pushes rows into a gmysql schema, while
`PowerdnsPipeBackend` is asked one question at a time. They share the rdata
encoder, so the two models cannot answer differently.

## FUNCTIONS

### getZones

Returns a list of zones (and zone files) from the specified nameserver config file.

### parseConfig

Does the heavy lifting for `getZones`. Accepts a string and returns an object where the keys are DNS zones and the value is the file with that zones resource records.

## FEATURES

- config parsers for bind, nsd, knot, maradns, and tinydns
- config generators for bind, nsd, knot, and maradns
- publishers for RFC 1035 zone files, tinydns cdb, maradns csv2, and PowerDNS
- a PowerDNS pipe backend (`nt-powerdns`)

## TODO

- [ ] config generator
  - [ ] bind
  - [ ] nsd
  - [ ] knot
  - [ ] maradns
  - [ ] tinydns
  - [x] powerdns ([#30](https://github.com/nictool/NicTool/issues/30))

## SEE ALSO

- [Dictionary of DNS terms](https://nictool.github.io/web/Dictionary)
- [Wikipedia, DNS Server Software](https://en.wikipedia.org/wiki/Comparison_of_DNS_server_software)

## DEVELOP

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  - fix, feature, BREAKING CHANGE, build, chore, ci, docs, style, test
- [keep a changelog](https://keepachangelog.com/)

[![Tests][test-img]][test-uri]
[![Coverage Status][cov-img]][cov-uri]

[test-img]: https://github.com/NicTool/dns-nameserver/actions/workflows/ci.yml/badge.svg
[test-uri]: https://github.com/NicTool/dns-nameserver/actions/workflows/ci.yml
[cov-img]: https://coveralls.io/repos/github/NicTool/dns-nameserver/badge.svg
[cov-uri]: https://coveralls.io/github/NicTool/dns-nameserver
