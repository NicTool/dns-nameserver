

import assert from 'assert'
// import fs     from 'fs/promises'

import { getZones } from '../lib/tinydns.js'


describe('tinydns', function () {

  describe('getZones', function () {
    it('returns a list of zones', async () => {

      const filePath = './test/fixtures/tinydns/ns1.theartfarm'
      const r = await getZones(filePath)
      // console.dir(r, { depth: null })
      const expected = new Map([
        [ '0.0.127.in-addr.arpa', 'data' ],
        [ 'allguitar.com', 'data' ],
        [ 'horsenetwork.com', 'data' ],
        [ 'lakeshoretower.com', 'data' ],
        [ 'neisgroup.com', 'data' ],
        [ 'theartfarm.com', 'data' ],
        [ 'timbersmart.com', 'data' ],
        [ 'mikezerbe.com', 'data' ],
        [ 'advancedgraphicimages.com', 'data' ],
        [ 'pleinairwest.com', 'data' ],
        [ 'lynboyer.com', 'data' ],
        [ 'tikismikis.org', 'data' ],
        [ 'horseshoeing.org', 'data' ],
        [ 'cadillacjaycees.org', 'data' ],
        [ 'durbensl.com', 'data' ],
        [ 'ehwushu.org', 'data' ],
        [ 'txalamako.org', 'data' ],
        [ 'alannowell.com', 'data' ],
        [ 'habispace.com', 'data' ],
        [ 'martagil.com', 'data' ],
        [ 'chefadmin.com', 'data' ],
        [ 'ellenscorners.biz', 'data' ],
        [ 'amandakiessel.com', 'data' ],
        [ 'carolesimon.com', 'data' ],
        [ 'onviewmagazine.com', 'data' ],
        [ 'animasacademics.com', 'data' ],
        [ 'equikits.com', 'data' ],
        [ 'durangotutoring.com', 'data' ],
        [ 'benkiessel.com', 'data' ],
        [ 'thewallacecollective.com', 'data' ],
        [ 'tatooshenv.com', 'data' ],
        [ 'immer-gucken.org', 'data' ],
        [ 'michigansolutionsgroup.com', 'data' ],
        [ 'lgptools.com', 'data' ],
        [ 'ansliabh.com', 'data' ],
        [ 'autosolutionsofmichigan.com', 'data' ],
        [ 'stonehouserecording.com', 'data' ],
        [ 'okfein.com', 'data' ],
        [ 'chainoflakesband.com', 'data' ],
        [ 'lucaswilsonmusic.com', 'data' ],
        [ '_report._dmarc.theartfarm.com', 'data' ],
        [ 'thesantarosalia.com', 'data' ],
        [ 'homesteadedmonds.com', 'data' ],
        [ 'workshopab2c.com', 'data' ],
        [ 'lasantarosalia.com', 'data' ],
        [ 'andreguimond.com', 'data' ],
        [ 'matchurchill.com', 'data' ],
        [ 'stumpgrindingbydale.com', 'data' ],
        [ '160/27.51.128.66.in-addr.arpa', 'data' ],
        [ 'wilsonwhitleymusic.com', 'data' ],
        [ 'solutionsconsultantsllc.com', 'data' ],
        [ 'rainydayreflections.net', 'data' ],
        [ 'siloremoval.com', 'data' ],
        [ 'cefalonia.org', 'data' ],
        [ 'w8ct.net', 'data' ],
        [ 'equilateralarchitecture.com', 'data' ],
        [ 'equi-lateral.com', 'data' ],
        [ 'qcwa10.net', 'data' ],
        [ 'interplayerartists.com', 'data' ],
        [ 'interplayartists.com', 'data' ],
        [ '_tcp.theartfarm.com', 'data' ],
        [ 'amenchorus.org', 'data' ],
        [ 'ctacllc.com', 'data' ],
      ])
      assert.deepStrictEqual(r, expected)
    })
  })
})