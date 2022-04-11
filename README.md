# dns-nameserver

Nameserver configuration parsers and generators


## SYNOPSIS

Name servers have configuration files, each with their own format. This package abstracts the unique implementations into a set of common actions.


## FUNCTIONS

### getZones

Returns a list of zones (and zone files) from the specified nameserver config file.




## TODO

- config parser
    - [x] bind
    - [x] nsd
    - [x] knot
    - [x] maradns
    - [x] tinydns
    - [ ] powerdns
- [ ] config generator
    - [ ] bind
    - [ ] nsd
    - [ ] knot
    - [ ] maradns
    - [ ] tinydns
    - [ ] powerdns



## SEE ALSO

- [Dictionary of DNS terms](https://nictool.github.io/web/Dictionary)
- [Wikipedia, DNS Server Software](https://en.wikipedia.org/wiki/Comparison_of_DNS_server_software)


## DEVELOP

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  + fix, feature, BREAKING CHANGE, build, chore, ci, docs, style, test
- [keep a changelog](https://keepachangelog.com/)
- [sentimental versioning](http://sentimentalversioning.org)
