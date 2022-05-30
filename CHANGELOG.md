# Change Log

### Unpublished


### 0.7.1 - 2022-05-29

- chore: publish npm package in @nictool namespace


### [0.7.0] - 2022-04-20

- feat: added index.isDelegated, and tests
- feat: add bin/cleanup
- feat: make index.fullPath windows compatible
- feat(nt-ns): added getTinyZones
- doc(README): add example ./bin/nt-ns.js
- chore(ci): replace .release with submodule
- chore(ci): depend on shared GHA workflows


### 0.6.0 - 2022-04-20

* import and validate zones from NS config ([72f0e2b](https://github.com/NicTool/dns-nameserver/commit/72f0e2b7f4d58a80edd6edad61cd5646e8bf80cb))
* use -v to also show all the RRs
* feat(tinydns): added getZone (extract RRs for a zone from data)
* feat(tinydns): also include . as SOA record


### 0.5.0 - 2022-04-15

* add getZones to bind, knot, mara, nsd, tiny ([4a125c8](https://github.com/NicTool/dns-nameserver/commit/4a125c89ffdaef2800a61dd31bd6de07d450f81a))
* cleanup: remove nearley parsers


### 0.4.0 - 2022-04-10

* convert from CJS to ESM ([11b66b2](https://github.com/NicTool/dns-nameserver/commit/11b66b2b83416fdb3338f9d537c9643814a13960))
* reimplement parsers in pure JS (bye nearley & moo)
* nsd: add value cleanups
* knot: handle array-type items
* test(bind): greatly improved test
* feat: start on nt-ns.js
* switch test coverage report nyc -> c8


### 0.3.0 - 2022-04-09

* add maradns config parser ([1b4608e](https://github.com/NicTool/dns-nameserver/commit/1b4608e22b60250a67823851772538418e59d187))
* split ns implementations into separate files
* fix(nsd): strip double quotes off values
* docs(nsd): tidy up and add comments


### 0.2.0 - 2022-04-08

* knot: add additional fixed sections ([b6acaa3](https://github.com/NicTool/dns-nameserver/commit/b6acaa301de2247059ec13dc0c2701aa36a101a0))
* knot: add URL to config file reference
* nsd: add parser ([fa49d1d](https://github.com/NicTool/dns-nameserver/commit/fa49d1da91e3e3bb2ac40d03bdfe60ea71b03710))


### 0.1.1 - 2022-04-07

* add knot config parser
* named.conf parser, basics


### 0.1.0 - 2022-04-02

* added CHANGELOG


[0.7.0]: https://github.com/NicTool/dns-nameserver/releases/tag/v0.7.0
[0.7.4]: https://github.com/NicTool/dns-nameserver/releases/tag/0.7.4
