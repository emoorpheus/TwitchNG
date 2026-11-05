#!/usr/bin/env python3
"""Twitch NG (NG = Next-Gen) brand assets -> SVG sources (pure paths, no font needed at runtime) + the logo block in web/twitchng.js.
  python3 brand/twitchng/src/make_assets.py         (then: node brand/twitchng/src/render.mjs -> PNGs + preview sheet)
Needs fontTools; hb-shape (harfbuzz) for kerning if present. Font: Noto Sans JP Black (SIL OFL 1.1), Latin glyphs only.
Icon variants (build/build-app.mjs --icon L3|L4|A|B|C; default L3):
  L3 default: an original TV drawn in Twitch's outline language (cut corners, 45-degree feet, two 'eye' bars), white on
     Twitch purple (geometry: tvmark.py, round 4).  Not Twitch artwork, but the purple + style + "Twitch" in the name read
     as Twitch - fine for your own TV / GitHub; for a store release use B / C with a name without "Twitch".
  L4 the same TV with a play sign instead of the eyes (no face).
  A  personal: the official-style white Glitch centred on purple + a small "NG" badge. The Glitch is a Twitch Interactive
     trademark (shape: Simple Icons 'twitch' path) - for your own TV only, not for a public release.
  B  own mark: original double play-chevron (speed) + the same "NG" badge on a teal-blue gradient - publishable.
  C  text: "NG" letters on the teal-blue gradient - publishable.
Splash (launch screen, 1920 x 1080): dark violet backdrop (not pure black) with a soft glow behind a large white mark;
  L3 / L4 / A: the mark above the full name "Twitch Next-Gen" (NG = Next-Gen); B / C: the mark alone (any app name).
  The first-run intro in the app repeats it (hero-V.svg, HEROS in web/twitchng.js); About keeps the "Twitch NG" lockup.
Writes icon-V.svg, splash-V.svg, mark-V.svg (in-app mark), logo-V.svg (in-app lockup, L3/L4/A), hero-V.svg (intro,
L3/L4/A), logo.svg (= logo-L3).  render.mjs turns them into PNGs (splash: 128-colour palette PNG via Pillow when present)."""
import json, os, re, shutil, subprocess, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvmark

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                         # brand/twitchng
FONT = os.environ.get('NG_FONT', '/usr/share/fonts/google-noto-cjk/NotoSansJP-Black.otf')
PURPLE, WHITE, BLACK = '#9146FF', '#FFFFFF', '#000000'
PURPLE_LIGHT, SPLASH_BG = '#BF94FF', '#08070D'       # 'Next-Gen' on dark; splash / intro backdrop (OLED-friendly, not #000)
FULL_NAME = ('Twitch', 'Next-Gen')                  # Twitch NG = Twitch Next-Gen: the splash / intro spell it out
# soft elliptical glow behind the splash mark: (offset, colour, opacity); B / C keep their own non-Twitch palette
GLOW_NG = ((0, PURPLE, .42), (.28, '#7A3AE6', .20), (.62, '#5B2AA8', .07), (1, '#3A1A70', 0))
TEAL, BLUE = '#00C9B7', '#3B5BFF'                    # B / C palette (deliberately not Twitch purple)
GLOW_BC = ((0, BLUE, .40), (.30, '#2F6FE0', .18), (.62, TEAL, .05), (1, TEAL, 0))
GLITCH = ('M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428'
          'L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z')
GBOX = (1.714, 0.0, 22.286, 24.0)                    # glitch bbox in its 24x24 viewBox

font = TTFont(FONT)
gs, order, upm = font.getGlyphSet(), font.getGlyphOrder(), font['head'].unitsPerEm
CAP = font['OS/2'].sCapHeight / upm                  # cap height in em
fmt = lambda v: ('%.1f' % v).rstrip('0').rstrip('.')

def shape(txt):
    """[(glyphName, x_advance_em, dx_em)] with kerning from hb-shape when available."""
    hb = shutil.which('hb-shape')
    if hb:
        out = subprocess.run([hb, '--output-format=json', '--no-glyph-names', FONT, txt], capture_output=True, text=True, check=True).stdout
        return [(order[g['g']], g['ax'] / upm, g['dx'] / upm) for g in json.loads(out)]
    cm = font.getBestCmap()
    return [(cm[ord(c)], font['hmtx'][cm[ord(c)]][0] / upm, 0.0) for c in txt]

def text_path(txt, size, x0, base):
    """SVG path of txt, font size `size` px, starting at x0, baseline `base` (y down). Returns (d, advance_px)."""
    pen, x = SVGPathPen(gs, ntos=fmt), 0.0
    for name, ax, dx in shape(txt):
        k = size / upm
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x0 + (x + dx) * size, base)))
        x += ax
    return pen.getCommands(), x * size

def ink_width(txt, size):
    """visible (ink) width of txt at `size` px and its left side bearing -> exact optical centring"""
    bp, x = BoundsPen(gs), 0.0
    for name, ax, dx in shape(txt):
        k = size / upm
        gs[name].draw(TransformPen(bp, (k, 0, 0, k, (x + dx) * size, 0)))
        x += ax
    b = bp.bounds
    return (b[2] - b[0], b[0]) if b else (x * size, 0.0)

def text_centered(txt, cap_px, cx, cy, fill):
    """txt with its cap height = cap_px, ink box centred on (cx, cy)"""
    size = cap_px / CAP
    w, lsb = ink_width(txt, size)
    d, _ = text_path(txt, size, cx - w / 2 - lsb, cy + cap_px / 2)
    return '<path fill="%s" d="%s"/>' % (fill, d), w

def glitch(x, y, h, fill):
    """glitch with its bbox top-left at (x, y), height h px"""
    s = h / (GBOX[3] - GBOX[1])
    return '<path fill="%s" fill-rule="evenodd" transform="translate(%.2f %.2f) scale(%.4f)" d="%s"/>' % (fill, x - GBOX[0] * s, y - GBOX[1] * s, s, GLITCH), (GBOX[2] - GBOX[0]) * s

def tvmark_path(v, x, y, h, fill):
    """TV mark v (L3 / L4) with its ink bbox top-left at (x, y), height h px -> (svg, width)"""
    x0, y0, x1, y1 = tvmark.BOX
    k = h / (y1 - y0)
    return ('<path fill="%s" fill-rule="evenodd" transform="translate(%.2f %.2f) scale(%.4f)" d="%s"/>'
            % (fill, x - x0 * k, y - y0 * k, k, tvmark.PATHS[v]())), (x1 - x0) * k

def icon_TV(v, n=512):
    """white TV mark on Twitch purple, 80% of the 256 grid (as on the round-4 board), no badge"""
    s = 0.8
    return svg(n, n, '<path fill="%s" fill-rule="evenodd" transform="translate(%s %s) scale(%.4f)" d="%s"/>'
               % (WHITE, fmt(n / 2 * (1 - s)), fmt(n / 2 * (1 - s)), s * n / 256, tvmark.PATHS[v]()), PURPLE)

def rtri(x, y, w, h, r):
    """right-pointing triangle with rounded corners, bbox (x, y, w, h), corner radius ~r (quadratic joins)"""
    pts = [(x, y), (x + w, y + h / 2), (x, y + h)]
    d = ''
    for i in range(3):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % 3]
        def toward(a, b, dist):
            dx, dy = b[0] - a[0], b[1] - a[1]; L = (dx * dx + dy * dy) ** 0.5; return (a[0] + dx * dist / L, a[1] + dy * dist / L)
        a, b = toward(p1, p0, r), toward(p1, p2, r)
        d += ('M' if i == 0 else 'L') + '%s %s' % (fmt(a[0]), fmt(a[1])) + 'Q%s %s %s %s' % (fmt(p1[0]), fmt(p1[1]), fmt(b[0]), fmt(b[1]))
    return d + 'Z'

def chevrons(cx, cy, h, fill_back, fill_front):
    """the B mark: two overlapping rounded play triangles (speed), ink box centred on (cx, cy), height h"""
    w = h * 0.86; off = w * 0.62; total = w + off
    x0, y0 = cx - total / 2, cy - h / 2
    r = h * 0.12
    return ('<path fill="%s" d="%s"/><path fill="%s" d="%s"/>' % (fill_back, rtri(x0, y0, w, h, r), fill_front, rtri(x0 + off, y0, w, h, r))), total

def grad(gid, a=TEAL, b=BLUE):
    return '<defs><linearGradient id="%s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>' % (gid, a, b)

def svg(w, h, body, bg=None, defs=''):
    rect = '<rect width="%d" height="%d" fill="%s"/>' % (w, h, bg) if bg else ''
    return '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">%s%s%s</svg>\n' % (w, h, w, h, defs, rect, body)

def badge(n, fill_bg, fill_text):
    """small "NG" badge, bottom-right, >= 7% margin (LG: >= 5 px padding at 80 px)"""
    ph, cap, m = n * 0.195, n * 0.108, n * 0.07
    size = cap / CAP
    tw, lsb = ink_width('NG', size)
    pw = tw + ph * 0.78
    x, y = n - m - pw, n - m - ph
    t, _ = text_centered('NG', cap, x + pw / 2, y + ph / 2, fill_text)
    return '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"/>' % (fmt(x), fmt(y), fmt(pw), fmt(ph), fmt(ph * 0.28), fill_bg) + t

def icon_A(n=512):
    """official-style: white Glitch centred on Twitch purple + small NG badge"""
    gh = n * 0.52
    gw = (GBOX[2] - GBOX[0]) * gh / 24.0
    g, _ = glitch(n / 2 - gw / 2, n / 2 - gh / 2, gh, WHITE)
    return svg(n, n, g + badge(n, WHITE, PURPLE), PURPLE)

def icon_B(n=512):
    m, _ = chevrons(n / 2, n * 0.47, n * 0.40, 'rgba(255,255,255,0.55)', WHITE)
    return svg(n, n, '<rect width="%d" height="%d" fill="url(#gB)"/>' % (n, n) + m + badge(n, WHITE, '#2F6FE0'), None, grad('gB'))

def icon_C(n=512):
    t, _ = text_centered('NG', n * 0.36, n / 2, n / 2, WHITE)
    return svg(n, n, '<rect width="%d" height="%d" fill="url(#gC)"/>' % (n, n) + t, None, grad('gC'))

def lockup(cx, cy, cap_px, mark='A', ng_fill=PURPLE, word_fill=WHITE, mark_fill=PURPLE):
    """horizontal lockup centred on (cx, cy): mark (A = Glitch, L3 / L4 = TV) + 'Twitch' + 'NG'; cap_px = wordmark cap height"""
    size = cap_px / CAP
    _, wsp = text_path('Twitch ', size, 0, 0)
    _, wn = text_path('NG', size, 0, 0)
    if mark == 'A':
        gh = cap_px * 1.62
        gw = (GBOX[2] - GBOX[0]) * gh / 24.0
        gap = cap_px * 0.42
    else:
        bx0, by0, bx1, by1 = tvmark.BOX
        gh = cap_px * 1.5
        gw = (bx1 - bx0) * gh / (by1 - by0)
        gap = cap_px * 0.5
    total = gw + gap + wsp + wn
    x0 = cx - total / 2
    if mark == 'A':
        g, _ = glitch(x0, cy - gh / 2, gh, mark_fill)
        top = cy - gh / 2
    else:   # the screen body (not the feet) is centred on the text
        k = gh / (by1 - by0)
        top = cy - (tvmark.BODY_CY - by0) * k
        g, _ = tvmark_path(mark, x0, top, gh, mark_fill)
    base = cy + cap_px / 2
    dt, _ = text_path('Twitch', size, x0 + gw + gap, base)
    dn, _ = text_path('NG', size, x0 + gw + gap + wsp, base)
    return g + '<path fill="%s" d="%s"/><path fill="%s" d="%s"/>' % (word_fill, dt, ng_fill, dn), total, (top, top + gh)

def words(parts, cap_px, cx, base):
    """one line of differently coloured words [(text, fill)], ink box centred on cx, baseline `base` -> (svg, ink width)"""
    size = cap_px / CAP
    w, lsb = ink_width(''.join(t for t, _ in parts), size)
    x, out = cx - w / 2 - lsb, ''
    for t, fill in parts:
        d, adv = text_path(t, size, x, base)
        out += '<path fill="%s" d="%s"/>' % (fill, d)
        x += adv
    return out, w

STACK = {'mark_h': 210, 'mark_h_A': 230, 'cap': 92, 'gap': 70}      # splash geometry in px at 1920 x 1080

def stack(cx, cy, mark, mark_fill=WHITE, word_fill=WHITE, accent=PURPLE_LIGHT):
    """vertical lockup centred on (cx, cy): mark (A = Glitch, L3 / L4 = TV) above 'Twitch Next-Gen'
    -> (svg, ink width, (top, bottom), y of the mark centre)"""
    mh, cap, gap = STACK['mark_h_A'] if mark == 'A' else STACK['mark_h'], STACK['cap'], STACK['gap']
    top = cy - (mh + gap + cap) / 2
    if mark == 'A':
        mw = (GBOX[2] - GBOX[0]) * mh / 24.0
        g, _ = glitch(cx - mw / 2, top, mh, mark_fill)
        mcy = top + mh / 2
    else:
        bx0, by0, bx1, by1 = tvmark.BOX
        mw = (bx1 - bx0) * mh / (by1 - by0)
        g, _ = tvmark_path(mark, cx - mw / 2, top, mh, mark_fill)
        mcy = top + (tvmark.BODY_CY - by0) * mh / (by1 - by0)
    t, tw = words([(FULL_NAME[0] + ' ', word_fill), (FULL_NAME[1], accent)], cap, cx, top + mh + gap + cap)
    return g + t, max(tw, mw), (top, top + mh + gap + cap), mcy

def glow(gid, cx, cy, stops, r=900, sy=0.62):
    """elliptical radial glow (x radius r, y radius r * sy) centred on (cx, cy)"""
    st = ''.join('<stop offset="%s" stop-color="%s" stop-opacity="%s"/>' % (fmt(o), c, fmt(a)) for o, c, a in stops)
    return ('<radialGradient id="%s" cx="%s" cy="%s" r="%s" gradientUnits="userSpaceOnUse" '
            'gradientTransform="translate(%s %s) scale(1 %s) translate(%s %s)">%s</radialGradient>'
            % (gid, fmt(cx), fmt(cy), fmt(r), fmt(cx), fmt(cy), fmt(sy), fmt(-cx), fmt(-cy), st))

def splash(v, w=1920, h=1080):
    """launch splash: SPLASH_BG + glow behind a large white mark; L3 / L4 / A with 'Twitch Next-Gen' below it"""
    defs = ''
    if v in LOCKUPS:
        body, _, _, gcy = stack(w / 2, h / 2 - 10, v)
        stops = GLOW_NG
    elif v == 'B':
        body, _ = chevrons(w / 2, h / 2, 190, 'url(#sB)', WHITE)
        gcy, stops, defs = h / 2, GLOW_BC, grad('sB')
    else:
        body, _ = text_centered('NG', 160, w / 2, h / 2, 'url(#sC)')
        gcy, stops, defs = h / 2, GLOW_BC, grad('sC')
    defs += '<defs>' + glow('glow', w / 2, gcy, stops) + '</defs>'
    return svg(w, h, '<rect width="%d" height="%d" fill="url(#glow)"/>' % (w, h) + body, SPLASH_BG, defs)

def hero_logo(mark='L3'):
    """first-run intro in the app: the splash composition (mark above 'Twitch Next-Gen'), tight viewBox (scaled by CSS)"""
    body, wid, (top, bot), _ = stack(0, 0, mark)
    pad = 4
    vb = (-wid / 2 - pad, top - pad, wid + 2 * pad, bot - top + 2 * pad)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f" class="ng-hero" aria-label="%s">%s</svg>'
            % (vb + (' '.join(FULL_NAME), body)))

def intro_logo(mark='L3'):
    """lockup for the in-app intro / About, tight viewBox (scaled by CSS)"""
    cap = 100.0
    body, total, (top, bot) = lockup(0, 0, cap, mark)
    top, bot = min(top, -cap / 2), max(bot, cap / 2)
    pad = 4
    vb = (-total / 2 - pad, top - pad, total + 2 * pad, bot - top + 2 * pad)
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f" class="ng-logo" aria-label="Twitch NG">%s</svg>' % (vb + (body,))

def mark(v):
    """in-app mark (next to the app name in HTML text) - 100 x 100 viewBox"""
    if v == 'A':
        g, _ = glitch(50 - (GBOX[2] - GBOX[0]) * 100 / 48, 0, 100, PURPLE)   # height 100, centred
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark">%s</svg>' % g
    if v in tvmark.PATHS:   # TV: width 100, centred vertically
        bx0, by0, bx1, by1 = tvmark.BOX
        h = 100 * (by1 - by0) / (bx1 - bx0)
        g, _ = tvmark_path(v, 0, 50 - h / 2, h, PURPLE)
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark">%s</svg>' % g
    if v == 'B':
        m, _ = chevrons(50, 50, 64, 'url(#ngmB)', WHITE)
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark">%s%s</svg>' % (grad('ngmB'), m)
    t, _ = text_centered('NG', 46, 50, 50, 'url(#ngmC)')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark">%s%s</svg>' % (grad('ngmC'), t)

VARIANTS = ('L3', 'L4', 'A', 'B', 'C')
LOCKUPS = ('L3', 'L4', 'A')            # variants with a "Twitch NG" lockup (used when the app name is "Twitch NG")

def main():
    out = {}
    for v in VARIANTS:
        out['icon-%s.svg' % v] = icon_TV(v, 512) if v in tvmark.PATHS else {'A': icon_A, 'B': icon_B, 'C': icon_C}[v](512)
        out['splash-%s.svg' % v] = splash(v)
        out['mark-%s.svg' % v] = mark(v) + '\n'
    for v in LOCKUPS: out['logo-%s.svg' % v], out['hero-%s.svg' % v] = intro_logo(v) + '\n', hero_logo(v) + '\n'
    out['logo.svg'] = out['logo-L3.svg']
    for k, val in out.items():
        with open(os.path.join(HERE, k), 'w') as f: f.write(val)
    for old in ('icon.svg', 'splash.svg', 'glitch.svg'):
        p = os.path.join(HERE, old)
        if os.path.exists(p): os.remove(p)
    js = os.path.join(ROOT, 'web', 'twitchng.js')
    if os.path.exists(js):
        src = open(js, encoding='utf-8').read()
        q = lambda s: s.replace('\\', '\\\\').replace("'", "\\'")
        block = ('    var LOGOS = {\n' + ',\n'.join("        %s: '%s'" % (v, q(intro_logo(v))) for v in LOCKUPS) + '\n    };\n'
                 '    var MARKS = {\n' + ',\n'.join("        %s: '%s'" % (v, q(mark(v))) for v in VARIANTS) + '\n    };\n'
                 '    var HEROS = {\n' + ',\n'.join("        %s: '%s'" % (v, q(hero_logo(v))) for v in LOCKUPS) + '\n    };\n')
        new, n = re.subn(r'(// <ng-logo>\n)[\s\S]*?(\n[ \t]*// </ng-logo>)', lambda m: m.group(1) + block.rstrip('\n') + m.group(2), src)
        if n != 1: sys.exit('twitchng.js: logo markers not found')
        open(js, 'w', encoding='utf-8').write(new)
    print('ok', {k: len(v) for k, v in out.items()})

if __name__ == '__main__':
    main()
