server:
    # use this number of cpu cores
    server-count: 1
    # We recommend leaving this empty, otherwise use "/var/db/nsd/nsd.db"
    database: ""
    #  the default file used for the nsd-control addzone and delzone commands
    # zonelistfile: "/var/db/nsd/zone.list"
    # The unprivileged user that will run NSD, can also be set to "" if
    # user privilige protection is not needed
    username: nsd
    # Default file where all the log messages go
    logfile: "/var/log/nsd.log"
    # Use this pid file instead of the platform specific default
    pidfile: "/var/run/nsd.pid"
    # Enable if privilege "jail" is needed for unprivileged user. Note
    # that other file paths may break when using chroot
    # chroot: "/etc/nsd/"
    # The default zone transfer file
    # xfrdfile: "/var/db/nsd/xfrd.state"
    # The default working directory before accessing zone files
    # zonesdir: "/etc/nsd"

remote-control:
    # this allows the use of 'nsd-control' to control NSD. The default is "no"
    control-enable: yes
    # the interface NSD listens to for nsd-control. The default is 127.0.0.1
    control-interface: 127.0.0.1
    # the key files that allow the use of 'nsd-control'. The default path is "/etc/nsd/". Create these using the 'nsd-control-setup' utility
    server-key-file: /etc/nsd/nsd_server.key
    server-cert-file: /etc/nsd/nsd_server.pem
    control-key-file: /etc/nsd/nsd_control.key
    control-cert-file: /etc/nsd/nsd_control.pem

zone:
    name: example.com
    zonefile: /etc/nsd/example.com.zone