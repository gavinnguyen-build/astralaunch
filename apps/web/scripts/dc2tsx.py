#!/usr/bin/env python3
"""
One-off converter: docs/design/<Name>.dc.html → apps/web/src/design/<Name>View.tsx (+ <Name>View.css).

Keeps the design markup and inline styles verbatim so pages match the designs exactly:
  - <sc-for list="{{xs}}" as="x">  → {(v.xs ?? []).map((x: any, i: number) => <Fragment key={i}>…</Fragment>)}
  - <sc-if value="{{c}}">          → {c ? <>…</> : null}
  - {{a.b}} bindings               → {v.a.b} (or {x.b} inside a loop over x)
  - style="…" (with bindings)      → style={{…}} objects (camelCase, !important dropped)
  - style-hover / style-active     → generated class + CSS rule (!important, beats inline style)
  - href="X.dc.html"               → href={route('X')}  (rendered by <A>, router-aware)
  - /_blob/<id>                    → /astralaunch-logo.png or /robots-atlas.png
  - <header>/<footer>              → <SiteHeader active=…/> / <SiteFooter/> (shared, hand-written)
  - root height                    → min-height (content is dynamic)
The <helmet><style> block becomes <Name>View.css. Output is hand-edited afterwards where
real data needs different structure; regenerate only if the design changes.

Usage: python3 apps/web/scripts/dc2tsx.py <Name> [<Name> …]
"""
import re, sys, os
from html.parser import HTMLParser

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SRC = os.path.join(ROOT, 'docs', 'design')
OUT = os.path.join(ROOT, 'apps', 'web', 'src', 'design')

BLOBS = {
    '99a75b3ad835989ddd438c67188e5265': '/astralaunch-logo.png',
    '6954211f7f79d2246a85e5d36e89fb3d': '/robots-atlas.png',
}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
ATTR_MAP = {
    'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex', 'readonly': 'readOnly',
    'maxlength': 'maxLength', 'autocomplete': 'autoComplete', 'inputmode': 'inputMode',
    'colspan': 'colSpan', 'rowspan': 'rowSpan', 'spellcheck': 'spellCheck',
    'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin',
    'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset', 'fill-rule': 'fillRule',
    'clip-rule': 'clipRule', 'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity', 'vector-effect': 'vectorEffect',
    'text-anchor': 'textAnchor', 'font-size': 'fontSize', 'font-family': 'fontFamily', 'font-weight': 'fontWeight',
    'dominant-baseline': 'dominantBaseline', 'stroke-opacity': 'strokeOpacity', 'fill-opacity': 'fillOpacity',
    # html.parser lowercases attribute names
    'viewbox': 'viewBox', 'preserveaspectratio': 'preserveAspectRatio',
}
EVENTS = {'onclick': 'onClick', 'onmousemove': 'onMouseMove', 'onmouseleave': 'onMouseLeave', 'onmouseenter': 'onMouseEnter',
          'onchange': 'onChange', 'oninput': 'onInput', 'onwheel': 'onWheel', 'onkeydown': 'onKeyDown', 'onsubmit': 'onSubmit'}
DROP = {'hint-placeholder-count', 'hint-placeholder-val', 'data-om-label'}
BIND = re.compile(r'\{\{\s*([^}]+?)\s*\}\}')
NAV = {'Discover': 'discover', 'Leaderboard': 'leaderboard', 'Creator': 'creator', 'Main': 'home'}


def camel(prop):
    if prop.startswith('--'):
        return repr(prop)
    if prop.startswith('-webkit-'):
        prop = 'Webkit-' + prop[len('-webkit-'):]
    parts = prop.split('-')
    return parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])


class Conv(HTMLParser):
    def __init__(self, name):
        super().__init__(convert_charrefs=False)
        self.name = name
        self.out = []
        self.depth_in_dc = 0
        self.in_dc = False
        self.in_helmet = False
        self.in_style = False
        self.css = []
        self.scopes = []          # loop variables in scope
        self.stack = []           # (tag, kind)
        self.skip = 0             # >0 while inside header/footer replaced by components
        self.hover_n = 0
        self.root_done = False
        self.active = None

    # ── helpers ──
    def expr(self, path):
        path = path.strip()
        if path in ('true', 'false'):
            return path
        root = re.split(r'[.\[]', path, maxsplit=1)[0]
        return path if root in self.scopes else f'v.{path}'

    def text_js(self, s):
        """Text node → JSX children with bindings."""
        parts, last = [], 0
        for m in BIND.finditer(s):
            parts.append(self.lit(s[last:m.start()]))
            parts.append('{' + self.expr(m.group(1)) + '}')
            last = m.end()
        parts.append(self.lit(s[last:]))
        return ''.join(parts)

    @staticmethod
    def lit(s):
        return s.replace('{', "{'{'}").replace('}', "{'}'}").replace('<', '&lt;').replace('>', '&gt;')

    def value_js(self, s):
        """Attribute value possibly containing bindings → JS expression."""
        ms = list(BIND.finditer(s))
        if len(ms) == 1 and ms[0].group(0) == s.strip():
            return self.expr(ms[0].group(1))
        if not ms:
            return repr(s).replace("\\'", "'") if "'" not in s else '"' + s.replace('"', '\\"') + '"'
        out, last = [], 0
        for m in ms:
            out.append(s[last:m.start()].replace('`', '\\`').replace('${', '\\${'))
            out.append('${' + self.expr(m.group(1)) + '}')
            last = m.end()
        out.append(s[last:].replace('`', '\\`'))
        return '`' + ''.join(out) + '`'

    def style_obj(self, style):
        decls = []
        buf, depth = '', 0
        for ch in style:           # split on ; outside parentheses
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            if ch == ';' and depth == 0:
                decls.append(buf); buf = ''
            else:
                buf += ch
        decls.append(buf)
        items = []
        for d in decls:
            if ':' not in d:
                continue
            k, val = d.split(':', 1)
            k, val = k.strip(), val.strip().replace('!important', '').strip()
            if not k:
                continue
            val = re.sub(r'/_blob/([0-9a-f]+)', lambda m: BLOBS.get(m.group(1), m.group(0)), val)
            items.append(f'{camel(k)}: {self.value_js(val)}')
        # CSS semantics: a later declaration of the same property wins (JS object keys must be unique)
        dedup = {}
        for it in items:
            dedup[it.split(':', 1)[0]] = it
        return '{ ' + ', '.join(dedup.values()) + ' }'

    def hover_rule(self, style, pseudo):
        self.hover_n += 1
        cls = f'dc-{self.name.lower()}-{pseudo}-{self.hover_n}'
        rule = style.replace('!important', '')
        rule = ';'.join(p.strip() + ' !important' for p in rule.split(';') if p.strip())
        self.css.append(f'.{cls}:{pseudo}{{{rule}}}')
        return cls

    def emit(self, s):
        if not self.skip:
            self.out.append(s)

    # ── parser callbacks ──
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'x-dc':
            self.in_dc = True; return
        if not self.in_dc:
            return
        if tag == 'helmet':
            self.in_helmet = True; return
        if self.in_helmet:
            if tag == 'style':
                self.in_style = True
            return
        if self.skip:
            if tag not in VOID:
                self.skip += 1
            return
        if tag == 'header':
            self.emit(f'<SiteHeader active={repr(self.active or "")} />')
            self.skip = 1; return
        if tag == 'footer':
            self.emit('<SiteFooter />')
            self.skip = 1; return
        if tag == 'sc-for':
            lst = BIND.search(a['list']).group(1)
            var = a['as']
            self.emit('{(' + self.expr(lst) + ' ?? []).map((' + var + ': any, ' + var + 'I: number) => (<Fragment key={' + var + 'I}>')
            self.scopes.append(var)
            self.stack.append((tag, 'for')); return
        if tag == 'sc-if':
            cond = BIND.search(a['value']).group(1)
            self.emit('{' + self.expr(cond) + ' ? (<>')
            self.stack.append((tag, 'if')); return

        jsx_tag = 'A' if tag == 'a' else tag
        props, classes = [], []
        for k, val in attrs:
            if k in DROP or val is None and k not in ('disabled', 'checked', 'selected', 'hidden', 'readonly'):
                if val is None and k in ('disabled', 'checked', 'selected', 'hidden'):
                    props.append(k)
                continue
            if k == 'style':
                st = val
                if not self.root_done and tag == 'div' and 'width: 1440px' in st:
                    st = re.sub(r'(?<![-\w])height: (\d+)px', r'min-height: \1px', st, count=1)
                    self.root_done = True
                props.append(f'style={{{self.style_obj(st)}}}')
            elif k in ('style-hover', 'style-active'):
                classes.append(self.hover_rule(val, 'hover' if k == 'style-hover' else 'active'))
            elif k == 'class':
                classes.extend(val.split())
            elif k == 'href':
                m = re.match(r'^(\w+)\.dc\.html$', val)
                if m:
                    props.append(f'href={{route({m.group(1)!r})}}')
                else:
                    props.append(f'href={{{self.value_js(val)}}}')
            elif k == 'src':
                val = re.sub(r'/_blob/([0-9a-f]+)', lambda m: BLOBS.get(m.group(1), m.group(0)), val)
                props.append(f'src={{{self.value_js(val)}}}')
            elif k.startswith('on') and BIND.search(val or ''):
                props.append(f'{EVENTS.get(k, k)}={{{self.value_js(val)}}}')
            elif k == 'ref':
                props.append(f'ref={{{self.value_js(val)}}}')
            elif k == 'value' and tag in ('input', 'textarea'):
                props.append(f'defaultValue={{{self.value_js(val)}}}')
            else:
                name = ATTR_MAP.get(k, k)
                props.append(f'{name}={{{self.value_js(val)}}}' if BIND.search(val or '') else f'{name}={self.value_js(val) if "{" in (val or "") else repr_attr(val)}')
        if classes:
            props.append(f'className={repr_attr(" ".join(classes))}')
        opener = '<' + jsx_tag + (' ' + ' '.join(props) if props else '')
        if tag in VOID:
            self.emit(opener + ' />')
        else:
            self.emit(opener + '>')
            self.stack.append((jsx_tag, 'el'))

    def handle_endtag(self, tag):
        if tag == 'x-dc':
            self.in_dc = False; return
        if not self.in_dc:
            return
        if tag == 'helmet':
            self.in_helmet = False; return
        if self.in_helmet:
            if tag == 'style':
                self.in_style = False
            return
        if self.skip:
            if tag not in VOID:
                self.skip -= 1
            return
        if tag in VOID:
            return
        jt, kind = self.stack.pop()
        if kind == 'for':
            self.scopes.pop()
            self.emit('</Fragment>))}')
        elif kind == 'if':
            self.emit('</>) : null}')
        else:
            self.emit(f'</{jt}>')

    def handle_data(self, data):
        if not self.in_dc:
            return
        if self.in_helmet:
            if self.in_style:
                self.css.append(data.strip())
            return
        if self.skip:
            return
        if data.strip() == '' and '\n' in data:
            self.emit('\n'); return
        self.emit(self.text_js(data))

    def handle_entityref(self, name):
        if self.in_dc and not self.in_helmet and not self.skip:
            self.emit(f'&{name};')

    def handle_charref(self, name):
        if self.in_dc and not self.in_helmet and not self.skip:
            self.emit(f'&#{name};')


def repr_attr(v):
    return '"' + (v or '').replace('"', '&quot;') + '"'


def convert(name):
    src = open(os.path.join(SRC, f'{name}.dc.html'), encoding='utf-8').read()
    c = Conv(name)
    m = re.search(r'aria-current="page"[^>]*>(\w+)<', src)
    c.active = NAV.get(m.group(1), m.group(1).lower()) if m else ''
    c.feed(src)
    body = ''.join(c.out).strip()
    os.makedirs(OUT, exist_ok=True)
    tsx = f"""// GENERATED from docs/design/{name}.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {{ Fragment }} from 'react';
import {{ A, route }} from '../components/A.js';
import {{ SiteHeader, SiteFooter }} from '../components/Site.js';
import './{name}View.css';

export function {name}View({{ v }}: {{ v: any }}) {{
  return (
{body}
  );
}}
"""
    open(os.path.join(OUT, f'{name}View.tsx'), 'w', encoding='utf-8').write(tsx)
    open(os.path.join(OUT, f'{name}View.css'), 'w', encoding='utf-8').write('\n'.join(x for x in c.css if x) + '\n')
    print(f'{name}: {len(body)} chars, {c.hover_n} hover/active rules, active nav={c.active!r}')


if __name__ == '__main__':
    for n in sys.argv[1:]:
        convert(n)
