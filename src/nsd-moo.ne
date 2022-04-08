@lexer lexer

main -> (
            comment {% id %}
          | blank   {% id %}
          | key     {% id %}
          | pattern {% id %}
          | remote  {% id %}
          | server  {% id %}
          | tls     {% id %}
          | zone    {% id %}
        ):*         {% id %}

blank       -> %blank            {% comment %}
comment     -> %comment          {% comment %}
key_val     -> %key_val          {% id %}
key         -> %key     (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}
pattern     -> %pattern (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}
remote      -> %remote  (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}
server      -> %server  (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}
tls         -> %tls     (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}
zone        -> %zone    (key_val {% asKeyValue %} | %comment {% comment %}):* {% asGroup %}

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

function comment (d) { return null }

function asGroup (d) {
  return { [d[0].type]: Object.assign({}, ...d[1].filter(e => typeof e !== 'null')) }
}

const kvRe = /^[ \t]+([^\s]+?):\s*?([^\r\n#]+)(#[^\r\n]+)?[\r\n]/

function asKeyValue (d) {
  const match = d[0].value.match(kvRe)
  return { [match[1]]: match[2].trim() }
}
%}
