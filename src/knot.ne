
main   -> (
            blank    {% id %}
          | comment  {% id %}
          | server   {% id %}
          | zone     {% id %}
          | log      {% id %}
          | acl      {% id %}
          | key      {% id %}
          | policy   {% id %}
          | remote   {% id %}
          | template {% id %}
          ):*

blank       -> _ eol                                  {% asNull %}
comment     -> _ "#" notEol eol                       {% asNull %}

key_val     -> __ word ":" __ word eol                {% asKeyVal %}

array_block -> __ "-" __ word ":" __ word _ eol (key_val {% id %}):* eol_   {% asArray %}

acl         -> "acl"      ":" eol (array_block {% id %}):* eol_ {% asTopObj %}
key         -> "key"      ":" eol (array_block {% id %}):* eol_ {% asTopObj %}
policy      -> "policy"   ":" eol (key_val     {% id %}):* eol  {% asTopObj %}
remote      -> "remote"   ":" eol (key_val     {% id %}):* eol  {% asTopObj %}
server      -> "server"   ":" eol (key_val     {% id %}):* eol  {% asTopObj %}
template    -> "template" ":" eol (array_block {% id %}):* eol_ {% asTopObj %}
zone        -> "zone"     ":" eol (array_block {% id %}):* eol_ {% asTopObj %}
log         -> "log"      ":" eol (array_block {% id %}):* eol_ {% asTopObj %}

_        -> [ \t]:*
__       -> [ \t]:+
eol      -> [\r\n]                                 {% id %}
eol_     -> [\r\n]:*                               {% id %}
hex      -> [A-Fa-f0-9]                            {% id %}
notEol   -> [^\r\n]:*
word     -> [A-Za-z-0-9_.@:/-]:+                   {% flatten %}
dqstring     -> "\"" dqcharacters "\""     {% d => Array.isArray(d[1]) ? d[1].join("") : d[1] %}
dqcharacters -> dqcharacter                {% id %}
              | dqcharacter dqcharacters   {% d => [d[0], ...d[1]] %}
dqcharacter  -> [^\"\\]                    {% id %}
              | "\\" escape                {% d => d[1] %}
escape       -> ["\\/bfnrt]                {% id %}
              | "u" hex hex hex hex {% (d) => String.fromCharCode(`0x${d.slice(1,5).join("")}`) %}

@{%
function asArray (d) {
  return Object.assign({ [d[3]]: d[6] }, ...d[9].filter(e => 'object' === typeof e))
}
function asTopObj (d) { return { [d[0]]: d[3] } }
function asKeyVal (d) { return { [d[1]]: d[4] } }
function asNull   (d) { return null; }
function flatten (d) {
  if (!d) return ''
  return Array.isArray(d) ? d.flat(Infinity).join('') : d
}
%}