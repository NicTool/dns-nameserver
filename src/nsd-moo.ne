# https://nsd.docs.nlnetlabs.nl/en/latest/manpages/nsd.conf.html
@lexer lexer

main -> (   comment {% id %}
          | blank   {% id %}
          | key     {% id %}
          | pattern {% id %}
          | remote  {% id %}
          | server  {% id %}
          | tls     {% id %}
          | zone    {% id %}
        ):*         {% id %}

blank       -> %blank           {% asComment %}
comment     -> %comment         {% asComment %}
key_val     -> %key_val         {% asKeyValue %}
attrib      -> key_val          {% id %}
             | comment          {% id %}
key         -> %key     (attrib {% id %}):* {% asGroup %}
pattern     -> %pattern (attrib {% id %}):* {% asGroup %}
remote      -> %remote  (attrib {% id %}):* {% asGroup %}
server      -> %server  (attrib {% id %}):* {% asGroup %}
tls         -> %tls     (attrib {% id %}):* {% asGroup %}
zone        -> %zone    (attrib {% id %}):* {% asGroup %}

@{%
const moo = require("moo");

const lexer = moo.compile({
  key    : /^key:\s*?[\r\n]/,
  pattern: /^pattern:\s*?[\r\n]/,
  remote : /^remote-control:\s*?[\r\n]/,
  server : /^server:\s*?[\r\n]/,
  tls    : /^tls-auth:\s*?[\r\n]/,
  zone   : /^zone:\s*?[\r\n]/,
  key_val: /^[ \t]+[^\s]+?:[^\r\n#]+(?:#[^\r\n]+)?[\r\n]/,
  blank  : /^\s*?$[\r\n]/,
  comment: /^\s*(?:#)[^\r\n]*?[\r\n]/,
});

function asComment (d) { return null }

function asGroup (d) {
  return {
    // merge the attributes into a top level "group"
    [d[0].type]: Object.assign({}, ...d[1].filter(e => typeof e !== 'null'))
  }
}

const kvRe = /^[ \t]+([^\s]+?):\s*?([^\r\n#]+)(#[^\r\n]+)?[\r\n]/

function asKeyValue (d) {
  const match = d[0].value.match(kvRe)
  return { [match[1]]: match[2].trim().replace(/^"(.*)"$/, '$1') }
}
%}
