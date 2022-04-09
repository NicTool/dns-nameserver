@lexer lexer

main -> (   comment    {% id %}
          | blank      {% id %}
          | variable   {% id %}
        ):*            {% id %}

blank    -> %blank     {% asNull %}
comment  -> %comment   {% asNull %}
variable -> %variable  {% asVariable %}

@{%
const moo = require("moo");

const lexer = moo.compile({
  variable: /^[^ \t]*\s*=\s*[^\r\n]*?[\r\n]/,
  blank  : /^\s*?$[\r\n]/,
  comment: /^\s*(?:#)[^\r\n]*?[\r\n]/,
});

function asNull (d) { return null }

const varRe = /^([^ \t]*)\s*=\s*([^\r\n]*?)[\r\n]/

function asVariable (d) {
  const match = d[0].value.match(varRe)
  return { [match[1]]: match[2].trim().replace(/^"(.*)"$/, '$1') }
}

%}
