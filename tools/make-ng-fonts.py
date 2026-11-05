#!/usr/bin/env python3
"""make-ng-fonts.py - Twitch NG UI font (brand/twitchng/web/fonts/ng-sans-{400,600,700,900}.woff2, CSS family "NG Sans").

Source: Onest 2.001 (variable, wght 100-900; SIL OFL 1.1, no Reserved Font Name), google/fonts ofl/onest - picked by the owner
(pre-release 06). Static instances 400 / 600 / 700 / 900 (old webOS engines have no variable fonts), subset to Latin + Latin Ext-A/B +
Cyrillic (+ punctuation, arrows, a few symbols; Onest has no Greek: Greek falls back to Roboto), named "NG Sans" so a later font swap
does not touch the CSS. Vertical metrics set to Roboto's (ascender 0.928 em, descender 0.244 em, no line gap): Onest has the same
cap / x height as Roboto, so the upstream layouts (line-height: normal, fixed-height boxes) keep their positions.
License text: brand/twitchng/web/fonts/OFL-Onest.txt.
Usage: python3 tools/make-ng-fonts.py [--src Onest[wght].ttf] [--any]   (downloads into /tmp when --src is missing; the source
       must match the pinned SHA-256 unless --any)
"""
import hashlib, os, sys, urllib.request
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'brand/twitchng/web/fonts')
URL = 'https://github.com/google/fonts/raw/main/ofl/onest/Onest%5Bwght%5D.ttf'
SHA256 = '966c5c29b4755da84b6854d5c21dd4eaa2420225d0e9874de602de176d4a9f31'   # Onest[wght].ttf 2.001 (METADATA.pb: simpals/onest 8739b19)
WEIGHTS = {400: 'Regular', 600: 'SemiBold', 700: 'Bold', 900: 'Black'}
UNI = ('U+0000-024F,U+0259,U+02B9-02BC,U+02C6-02C7,U+02DA,U+02DC,U+0300-0304,U+0306-0308,U+030A-030C,U+0327-0328,'
       'U+0400-045F,U+0490-0491,U+04D8-04D9,U+04E8-04E9,U+2000-206F,U+20AC,U+20BD,U+20B4,U+2116,U+2122,U+2190-2193,U+2212,U+2215,'
       'U+2713,U+FEFF,U+FFFD')
ASC, DESC = 928, -244   # Roboto: 1900 / -500 at 2048 upm

def src_file():
    if '--src' in sys.argv: return sys.argv[sys.argv.index('--src') + 1]
    p = '/tmp/onest/Onest.ttf'
    if not os.path.isfile(p):
        os.makedirs(os.path.dirname(p), exist_ok=True); urllib.request.urlretrieve(URL, p)
    return p

def main():
    src, total = src_file(), 0
    h = hashlib.sha256(open(src, 'rb').read()).hexdigest()
    print('source %s sha256 %s' % (os.path.basename(src), h))
    if h != SHA256 and '--any' not in sys.argv: sys.exit('unexpected source file (pinned %s); --any to build from it anyway' % SHA256)
    for w, style in WEIGHTS.items():
        f = instancer.instantiateVariableFont(TTFont(src), {'wght': w}, updateFontNames=False)
        o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'tnum', 'case']
        o.name_IDs = ['*']; o.name_languages = ['*']; o.notdef_outline = True; o.hinting = False
        s = subset.Subsetter(o); s.populate(unicodes=subset.parse_unicodes(UNI)); s.subset(f)
        for t in ('STAT',):
            if t in f: del f[t]
        hh, os2 = f['hhea'], f['OS/2']
        hh.ascent, hh.descent, hh.lineGap = ASC, DESC, 0
        os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = ASC, DESC, 0
        os2.fsSelection |= 1 << 7   # USE_TYPO_METRICS (win metrics stay: no clipping of tall accents)
        os2.usWeightClass = w
        nm = f['name']
        for rec in list(nm.names):
            if rec.nameID in (1, 2, 3, 4, 6, 10, 16, 17, 21, 22, 25) or rec.nameID >= 256: nm.removeNames(nameID=rec.nameID)
        fam = 'NG Sans' if w in (400, 700) else 'NG Sans ' + style
        for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
            nm.setName(fam, 1, pid, eid, lid); nm.setName('Bold' if w == 700 else 'Regular', 2, pid, eid, lid)
            nm.setName('NG Sans %s; Onest 2.001 static subset (OFL-1.1)' % style, 3, pid, eid, lid)
            nm.setName('NG Sans %s' % style, 4, pid, eid, lid); nm.setName('NGSans-%s' % style, 6, pid, eid, lid)
            nm.setName('NG Sans', 16, pid, eid, lid); nm.setName(style, 17, pid, eid, lid)
        nm.setName('Twitch NG UI font: static wght %d instance of Onest 2.001 (The Onest Project Authors, SIL OFL 1.1), subset '
                   '(Latin, Latin Ext, Cyrillic, punctuation), Roboto-like vertical metrics.' % w, 10, 3, 1, 0x409)
        f.recalcTimestamp = False; f['head'].modified = f['head'].created   # reproducible output
        out = os.path.join(OUT, 'ng-sans-%d.woff2' % w); f.flavor = 'woff2'; f.save(out)
        total += os.path.getsize(out); print('%s %d B, %d glyphs' % (os.path.basename(out), os.path.getsize(out), len(f.getBestCmap())))
    print('total %d B' % total)

if __name__ == '__main__':
    main()
