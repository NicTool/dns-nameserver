# DNS Nameserver Factory — Configuration Flowcharts

The pipeline is always: **Source → Publisher → [Signer] → Transport → destination**. The Transport drives the cadence; the other three stages are stateless transforms.

---

## A) In-process DNS server (RAM, loaded from files)

**Component choices:** `TomlSource` · `MemoryPublisher` · `NoneSigner` · `NoopTransport` · `NativeNS`

```mermaid
flowchart TD
    subgraph ASSEMBLE["1 · Assemble NativeNS"]
        src["TomlSource\npath: ./data\n(zone.toml + zone_record.toml)"]
        pub["MemoryPublisher\nholds live Map in process"]
        sig["NoneSigner\n(or MemorySigner for DNSSEC)"]
        trn["NoopTransport\ninterval: 300 s  cooldown: 5 s"]
        ns["NativeNS\nlisten: 0.0.0.0:53  udp + tcp"]
        src & pub & sig & trn --> ns
    end

    subgraph START["2 · ns.start()"]
        sc["source.connect() — no-op for TOML"]
        ts["transport.start(publishCycle)\nbinds UDP + TCP sockets via dns2"]
        sc --> ts
    end

    subgraph CYCLE["3 · publishCycle()  (runs every 300 s or on zoneChanged)"]
        gz["source.getZones()\nread zone.toml → zones\nread zone_record.toml → records\nfilter deleted, key by zone name"]
        pp["publisher.publish(zones)\natomic Map swap\n{ kind:'memory', zoneCount }"]
        ss["signer.sign(artifacts)\nnoop pass-through\n(MemorySigner adds RRSIG/DNSKEY inline)"]
        td["transport.deliver(artifacts)\nnoop — RAM already updated"]
        gz --> pp --> ss --> td
        td -->|"setTimeout(interval)\nor source 'zoneChanged'"| gz
    end

    subgraph QUERY["4 · DNS query handling"]
        qin["UDP/TCP packet arrives"]
        hq["handleQuery(request)\nextract q.name, q.type"]
        fz["publisher.findZone(qname)\nlongest-suffix match"]
        nx["rcode=NXDOMAIN"]
        fr["findRecords(zone, qname, qtype)\nencode A/AAAA/MX/NS/TXT/SOA/…"]
        send["send response\n(authoritative bit aa=1)"]
        qin --> hq --> fz
        fz -->|"no zone"| nx
        fz -->|"zone found"| fr --> send
    end

    ns --> sc
    pp -.->|"zones live here"| fz
```

**Config object:**

```js
new NativeNS({
  source: new TomlSource({ path: './data' }),
  publisher: new MemoryPublisher(),
  signer: new NoneSigner(),
  transport: new NoopTransport({ interval: 300, cooldown: 5 }),
  listen: [
    { address: '0.0.0.0', port: 53, proto: 'udp' },
    { address: '0.0.0.0', port: 53, proto: 'tcp' },
  ],
})
```

---

## B) MySQL backend → NSD (traditional nameserver)

**Component choices:** `MysqlSource` · `Rfc1035Publisher` · `Rfc1035Signer` (optional) · `RsyncTransport` or `AxfrTransport` · `NsdNS`

```mermaid
flowchart TD
    subgraph ASSEMBLE["1 · Assemble NsdNS"]
        src["MysqlSource\nDSN: mysql://user:pass@host/nictool\n(scaffolded — implement getZones + connect)"]
        pub["Rfc1035Publisher\npath: ./zones-out"]
        sig["Rfc1035Signer  (optional)\nruns dnssec-signzone on each file"]
        trn["RsyncTransport\nremote: nsd@ns1.example.com:/etc/nsd/zones\ninterval: 300 s\n───── or ─────\nAxfrTransport\nmaster: 127.0.0.1  (send NOTIFY → AXFR pull)"]
        ns["NsdNS  (FileEngine)\nno sockets bound here"]
        src & pub & sig & trn --> ns
    end

    subgraph START["2 · ns.start()"]
        sc["source.connect()\nopen MySQL connection pool"]
        ts["transport.start(publishCycle)\ninitial publishCycle() fires immediately"]
        sc --> ts
    end

    subgraph CYCLE["3 · publishCycle()  (every 300 s or on MysqlSource 'zoneChanged')"]
        gz["source.getZones({ nameserverId })\nSELECT nt_zone JOIN nt_zone_nameserver\n  JOIN nt_zone_record\nfilter deleted, group by zone"]
        pp["publisher.publish(zones)\nfor each zone → render RFC 1035 text\nwrite tmp file → atomic rename\n→ ./zones-out/example.com.zone\nartifacts: { directory, files[] }"]
        ss["signer.sign(artifacts)\nfor each file: dnssec-signzone\n(skipped if NoneSigner)"]
        td["transport.deliver(artifacts)"]
        gz --> pp --> ss --> td
        td -->|"setTimeout(interval)"| gz
    end

    subgraph RSYNC["RsyncTransport.deliver()"]
        rs["rsync -az --delete\n  ./zones-out/\n  nsd@ns1.example.com:/etc/nsd/zones/"]
        rl["nsd-control reload  (post-hook or manual)"]
        nsd["NSD serves DNS"]
        rs --> rl --> nsd
    end

    subgraph AXFR["AxfrTransport.deliver()  (alternate)"]
        ax["send DNS NOTIFY to configured master IP"]
        nsdp["NSD receives NOTIFY\npulls zone via AXFR"]
        nsd2["NSD serves DNS"]
        ax --> nsdp --> nsd2
    end

    ns --> sc
    td -->|rsync path| rs
    td -->|axfr path| ax
```

**Config object:**

```js
new NsdNS({
  source: new MysqlSource({ dsn: 'mysql://nictool:pass@127.0.0.1/nictool' }),
  publisher: new Rfc1035Publisher({ path: './zones-out' }),
  signer: new NoneSigner(), // or Rfc1035Signer
  transport: new RsyncTransport({
    remote: 'nsd@ns1.example.com:/etc/nsd/zones',
    interval: 300,
    cooldown: 5,
  }),
})
```

---

## C) Publishing to a SaaS DNS provider via their API

**Component choices:** `TomlSource` or `MysqlSource` · **custom `SaasPublisher`** · `NoneSigner` · `NoopTransport` · `FileEngine`

> **Note:** No built-in SaaS publisher exists yet. The framework is designed for it — subclass `Publisher` and the rest wires up identically. The SaaS API call happens inside `publish()`, so `NoopTransport` is correct (delivery is implicit in the publish step, the same pattern as `PowerdnsDbPublisher`).

```mermaid
flowchart TD
    subgraph ASSEMBLE["1 · Assemble FileEngine (SaaS target)"]
        src["TomlSource  or  MysqlSource\n(same as scenarios A & B)"]
        pub["CloudflarePublisher  /  Route53Publisher\n(custom subclass of Publisher)\nholds previous zone state for diffing"]
        sig["NoneSigner\n(SaaS handles DNSSEC internally)"]
        trn["NoopTransport\n(delivery is inside publish step)\ninterval: 60 s  cooldown: 5 s"]
        ns["FileEngine\n(no sockets — SaaS is the serving layer)"]
        src & pub & sig & trn --> ns
    end

    subgraph START["2 · ns.start()"]
        sc["source.connect()\n+ publisher authenticates to SaaS API"]
        ts["transport.start(publishCycle)"]
        sc --> ts
    end

    subgraph CYCLE["3 · publishCycle()"]
        gz["source.getZones()\n(TOML files or MySQL rows)"]
        pp["SaasPublisher.publish(zones)"]
        ss["signer.sign(artifacts) — pass-through"]
        td["transport.deliver(artifacts) — noop"]
        gz --> pp --> ss --> td
        td -->|"setTimeout(interval) or zoneChanged"| gz
    end

    subgraph SAASPUB["SaasPublisher.publish() internals"]
        fetch["fetch current zones from provider API\n(e.g. GET /zones)"]
        diff["diff: desired (source) vs actual (provider)\ncompute creates / updates / deletes"]
        batch["batch API calls\nPOST /zones/:id/records\nPATCH /zones/:id/records/:rid\nDELETE /zones/:id/records/:rid"]
        cache["update internal state cache\nreturn artifacts { provider, zonesChanged }"]
        fetch --> diff --> batch --> cache
    end

    subgraph PROVIDERS["SaaS DNS provider\n(authoritative — NicTool never binds a socket)"]
        cf["Cloudflare DNS"]
        r53["Route 53"]
        gcd["Google Cloud DNS"]
        edns["easyDNS / Dyn / …"]
    end

    ns --> sc
    pp --> fetch
    cache --> ss
    batch --> cf & r53 & gcd & edns
```

**Config object (Cloudflare example):**

```js
new FileEngine({
  engine: 'cloudflare',
  source: new TomlSource({ path: './data' }),
  publisher: new CloudflarePublisher({
    // implement Publisher subclass
    apiToken: process.env.CF_API_TOKEN,
    accountId: process.env.CF_ACCOUNT_ID,
  }),
  signer: new NoneSigner(),
  transport: new NoopTransport({ interval: 60, cooldown: 5 }),
})
```

---

## Summary comparison

|                           | **A: NativeNS (RAM)**         | **B: NSD (file-based)**            | **C: SaaS API**               |
| ------------------------- | ----------------------------- | ---------------------------------- | ----------------------------- |
| **Source**                | `TomlSource`                  | `MysqlSource`                      | `TomlSource` or `MysqlSource` |
| **Publisher**             | `MemoryPublisher`             | `Rfc1035Publisher`                 | custom `SaasPublisher`        |
| **Signer**                | `NoneSigner` / `MemorySigner` | `Rfc1035Signer` (optional)         | `NoneSigner`                  |
| **Transport**             | `NoopTransport`               | `RsyncTransport` / `AxfrTransport` | `NoopTransport`               |
| **Engine**                | `NativeNS`                    | `NsdNS` / `BindNS` / `KnotNS`      | `FileEngine`                  |
| **Who serves DNS?**       | `dns2` in-process             | NSD daemon on remote host          | SaaS provider                 |
| **Delivery mechanism**    | RAM Map swap                  | `rsync` push or DNS NOTIFY/AXFR    | REST API calls in `publish()` |
| **DNSSEC**                | in-process signing            | `dnssec-signzone` on zone files    | provider-managed              |
| **configure.html engine** | `native`                      | `nsd` / `bind` / `knot`            | _(not yet in UI)_             |
