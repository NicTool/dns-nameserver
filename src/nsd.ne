# https://nsd.docs.nlnetlabs.nl/en/latest/manpages/nsd.conf.html

main   -> (
            blank    {% id %}
          | comment  {% id %}
          | key      {% id %}
          | pattern  {% id %}
          | remote   {% id %}
          | server   {% id %}
          | tlsauth  {% id %}
          | zone     {% id %}
          ):*

blank       -> _ eol                                  {% asNull %}
comment     -> _ "#" notEol eol                       {% asNull %}

key_val     -> __ word ":" __ word (__ word):? (comment):? eol_                #{% asKeyVal %}

key         -> "key"            ":" eol (key_val {% id %}):* eol_ {% asTopObj %}
pattern     -> "pattern"        ":" eol (key_val {% id %}):* eol_ {% asTopObj %}
remote      -> "remote-control" ":" eol (key_val {% id %}):* eol_ {% asTopObj %}
server      -> "server"         ":" eol (key_val {% id %}):* eol  {% asTopObj %}
tlsauth     -> "tls-auth"       ":" eol (key_val {% id %}):* eol_ {% asTopObj %}
zone        -> "zone"           ":" eol (key_val {% id %} | comment {% id %}):* eol_ {% asTopObj %}

_        -> [ \t]:*
__       -> [ \t]:+
eol      -> [\r\n]                                 {% id %}
eol_     -> [\r\n]:*                               {% id %}
hex      -> [A-Fa-f0-9]                            {% id %}
notEol   -> [^\r\n]:*
word     -> [A-Za-z-0-9_.@:/-]:+                   {% flatten %}
          | dqstring

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