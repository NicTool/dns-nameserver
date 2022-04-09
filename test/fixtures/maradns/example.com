
csv2 = {}
csv2["example.com."] = "db.example.com"
csv2["example2.com."] = "db.example2.com"

ipv4_bind_addresses = "10.1.2.3,10.1.2.4,127.0.0.1"

chroot_dir = "/etc/maradns"

maradns_uid = 99
maradns_gid = 99

no_fingerprint = 0

max_chain = 8
max_ar_chain = 1
max_total = 20

verbose_level = 3
zone_transfer_acl = "10.1.1.1/24, 10.100.100.100/255.255.255.224"
