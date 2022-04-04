@lexer lexer

main        -> (comment | blank | block):*  {% id %}

blank       -> %blank       {% id %}
comment     -> %comment     {% comment %}
block       -> %options (opt | comment):+ %eoblock  {% optValue %}
             | %logging (opt | comment | optblock):+ %eoblock
             | zone         {% id %}

opt         -> %opt         {% optValue %}
optblock    -> %optblock
zone        -> %zone    (zonefile | zonetype | opt | comment):+ %eoblock {% asZone %}
zonefile    -> %zonefile    {% asZoneFile %}
zonetype    -> %zonetype    {% asZoneType %}

@{%
const moo = require("moo");

const lexer = moo.compile({
  blank:  /^\s*?$[\n\r]/,
  comment: /^\s*(?:\/\/|#)[^\n]*?\n/,
  eoblock: /};\s*\n/,
  zone: {
      match: /\s*zone\s+[^\s]+\s+(?:in|IN)?\s*{\n/s,
      value: f => f.trim().match(/zone\s+"([^"]+)"/)[1]
  },
  zonetype: /\s*type\s+(?:master|slave|hint);\n/,
  zonefile: /\s*file\s+"[^"]*?";\n/,
  logging : /\s*logging\s*{$\n/s,
  options : /\s*options\s+{$\n/s,
  opt     : { match: /^\s*[^\n]*?;$\n/s, value: f => f.trim() },
  optblock: /^\s*[^\n]+?{[^}]*?};\n/,
  nl      : { match: /\n\r/, lineBreaks: true },
  ws      : /[ \t]+/,
});

function comment (d) { return null }
function flatten (d) {
  if (!d) return ''
  return Array.isArray(d) ? d.flat(Infinity).join('') : d
}
function optValue (d) { return (d.type === 'obj') ? d.value : d }
function asZoneType (d) {
  return { ztype: d[0].value.trim().match(/type\s+(\w+?);/)[1] }
}
function asZoneFile (d) {
  return { zfile: d[0].value.trim().match(/file\s+"([^\"]+)";/)[1] }
}
function asZone (z) {
  if (!Array.isArray(z)) return z
  if (z[0] === null) return z[0]
  if (typeof z[0] !== 'object') return z[0]

  return {
    zone: z[0].value,
    type: z[1].filter(y => y[0] && y[0].ztype)[0][0].ztype,
    file: z[1].filter(y => y[0] && y[0].zfile)[0][0].zfile,
  }
}

%}