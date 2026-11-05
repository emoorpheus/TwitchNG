#!/usr/bin/env python3
"""make-ng-fonts.py - Twitch NG UI font (brand/twitchng/web/fonts/ng-sans-{400,600,700,900}.woff2).

Source: Adobe Source Sans 3 (3.052R, SIL OFL 1.1) - the same letterforms as the splash wordmark. Subset to Latin + Latin Ext-A/B +
Greek + Cyrillic (+ punctuation, arrows, a few symbols) and renamed to "NG Sans": the OFL reserves the font name "Source" for the
original, a subset is a Modified Version. License text: brand/twitchng/web/fonts/OFL-SourceSans3.md.
Usage: python3 tools/make-ng-fonts.py [--src DIR_WITH_TTF]   (downloads the release zip into /tmp when --src is missing)
"""
import os, sys, zipfile, urllib.request
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'brand/twitchng/web/fonts')
ZIP = 'https://github.com/adobe-fonts/source-sans/releases/download/3.052R/TTF-source-sans-3.052R.zip'
WEIGHTS = {400: 'Regular', 600: 'Semibold', 700: 'Bold', 900: 'Black'}
UNI = ('U+0000-024F,U+0259,U+02B9-02BC,U+02C6-02C7,U+02DA,U+02DC,U+0300-0304,U+0306-0308,U+030A-030C,U+0327-0328,U+0370-03FF,'
       'U+0400-045F,U+0490-0491,U+04D8-04D9,U+04E8-04E9,U+2000-206F,U+20AC,U+20BD,U+20B4,U+2116,U+2122,U+2190-2193,U+2212,U+2215,'
       'U+25CF,U+25B2-25BC,U+2713,U+FEFF,U+FFFD')

def src_dir():
    if '--src' in sys.argv: return sys.argv[sys.argv.index('--src') + 1]
    d = '/tmp/ss3'
    if not os.path.isdir(os.path.join(d, 'TTF')):
        z = '/tmp/ss3.zip'; urllib.request.urlretrieve(ZIP, z); zipfile.ZipFile(z).extractall(d)
    return os.path.join(d, 'TTF')

def main():
    src, total = src_dir(), 0
    for w, n in WEIGHTS.items():
        o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'tnum', 'case']
        o.name_IDs = ['*']; o.name_languages = ['*']; o.notdef_outline = True; o.hinting = False; o.desubroutinize = True
        f = TTFont(os.path.join(src, 'SourceSans3-%s.ttf' % n))
        s = subset.Subsetter(o); s.populate(unicodes=subset.parse_unicodes(UNI)); s.subset(f)
        style = {400: 'Regular', 600: 'SemiBold', 700: 'Bold', 900: 'Black'}[w]
        nm = f['name']
        for rec in list(nm.names):
            if rec.nameID in (1, 2, 3, 4, 6, 10, 16, 17, 21, 22, 25): nm.removeNames(nameID=rec.nameID)
        fam = 'NG Sans' if w in (400, 700) else 'NG Sans ' + style
        for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
            nm.setName(fam, 1, pid, eid, lid); nm.setName('Bold' if w == 700 else 'Regular', 2, pid, eid, lid)
            nm.setName('NG Sans %s; subset of Source Sans 3 3.052 (OFL-1.1)' % style, 3, pid, eid, lid)
            nm.setName('NG Sans %s' % style, 4, pid, eid, lid); nm.setName('NGSans-%s' % style, 6, pid, eid, lid)
            nm.setName('NG Sans', 16, pid, eid, lid); nm.setName(style, 17, pid, eid, lid)
        nm.setName('Twitch NG UI font: subset (Latin, Latin Ext, Greek, Cyrillic, punctuation) of Adobe Source Sans 3 3.052, '
                   'renamed per the OFL Reserved Font Name clause.', 10, 3, 1, 0x409)
        out = os.path.join(OUT, 'ng-sans-%d.woff2' % w); f.flavor = 'woff2'; f.save(out)
        total += os.path.getsize(out); print('%s %d B, %d glyphs' % (os.path.basename(out), os.path.getsize(out), len(f.getBestCmap())))
    print('total %d B' % total)

if __name__ == '__main__':
    main()
