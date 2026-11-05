"""Twitch NG 'TV' marks (round 4, chosen: L3) - drawn from scratch on a 256 grid in Twitch's outline language
(outline window, 45-degree cuts top-left / bottom-right, uniform stroke on the diagonals, 45-degree feet); no Twitch
artwork traced.  L3 = TV with two 'eye' bars (default icon), L4 = the same TV with a play sign.
Every function returns one SVG path (fill-rule evenodd), 256 x 256 grid; BOX = ink bbox of the TV marks."""
import math
R2, R3 = math.sqrt(2), math.sqrt(3)
BOX = (24.0, 46.0, 232.0, 212.0)          # x0, y0, x1, y1 (feet included)
BODY_CY = (46.0 + 192.0) / 2              # vertical centre of the screen body (without feet)
f = lambda v: ('%.2f' % v).rstrip('0').rstrip('.')
def poly(pts): return 'M' + 'L'.join('%s %s' % (f(x), f(y)) for x, y in pts) + 'Z'

def frame(x0, y0, x1, y1, t, ctl, cbr, feet=None):
    """outline window: outer contour with a top-left (ctl) and a bottom-right (cbr) 45-degree cut, inner window inset by
    t with the same cuts (diagonal stroke kept = t), optional two 45-degree parallelogram feet merged into the contour."""
    outer = [(x0 + ctl, y0), (x1, y0), (x1, y1 - cbr), (x1 - cbr, y1)]
    if feet:
        (fa, fb), fw, fh = feet
        outer += [(fb + fw, y1), (fb + fw + fh, y1 + fh), (fb + fh, y1 + fh), (fb, y1),
                  (fa + fw, y1), (fa + fw - fh, y1 + fh), (fa - fh, y1 + fh), (fa, y1)]
    outer += [(x0, y1), (x0, y0 + ctl)]
    ix0, iy0, ix1, iy1 = x0 + t, y0 + t, x1 - t, y1 - t
    ictl = max(ctl - t + t * R2 - t, 0) if ctl else 0
    icbr = cbr - t + (t * R2 - t) if cbr else 0
    inner = [(ix0 + ictl, iy0), (ix1, iy0), (ix1, iy1 - icbr), (ix1 - icbr, iy1), (ix0, iy1), (ix0, iy0 + ictl)]
    return poly(outer) + poly(inner), ((ix0 + ix1) / 2, (iy0 + iy1) / 2)

def tv():
    return frame(24, 46, 232, 192, 24, 22, 42, feet=((70, 160), 26, 20))

def playtri(cx, cy, h):
    w = h * R3 / 2
    return poly([(cx - w / 3, cy - h / 2), (cx + w * 2 / 3, cy), (cx - w / 3, cy + h / 2)])

def L3():
    d, (cx, cy) = tv()
    bw, bh, gap = 22, 50, 30
    return d + poly([(cx - gap / 2 - bw, cy - bh / 2), (cx - gap / 2, cy - bh / 2), (cx - gap / 2, cy + bh / 2), (cx - gap / 2 - bw, cy + bh / 2)]) \
             + poly([(cx + gap / 2, cy - bh / 2), (cx + gap / 2 + bw, cy - bh / 2), (cx + gap / 2 + bw, cy + bh / 2), (cx + gap / 2, cy + bh / 2)])

def L4():
    d, (cx, cy) = tv()
    return d + playtri(cx + 2, cy, 62)

PATHS = {'L3': L3, 'L4': L4}
