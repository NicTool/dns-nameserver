
import * as index from '../index.js'

import * as tinydns from '../lib/tinydns.js'

async function getZones () {
  return await tinydns.getZones('ignore/tinydns/data-ns2.cadillac')
}

getZones()
  .then(async zones => {

    for (const z of zones.keys()) {
      const r = await index.isDelegated(z, [ 'ns2.cadillac.net' ])
      if (r) {
        // console.log(`ok, ${z}`)
      }
      else {
        console.log(`DELETE ns FROM nt_zone_nameserver ns JOIN nt_zone z ON ns.nt_zone_id=z.nt_zone_id WHERE z.zone='${z}' AND ns.nt_nameserver_id='4';`)
      }
    }
    return zones
  })
  .catch(e => {
    console.error(e)
  })
