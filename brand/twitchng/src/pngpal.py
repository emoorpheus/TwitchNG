#!/usr/bin/env python3
"""pngpal.py <file.png> [core] - rewrite a PNG in place as an 8-bit palette PNG, lossless where it matters.
Used by render.mjs for the splash: its soft glow is Chromium-dithered (no banding) and a 24-bit PNG stores that noise badly
(~0.54 MB). The `core` (default 192) most frequent colours - the dithered backdrop, ~99 % of the pixels - go into the palette
exactly (error 0, the dither survives); the other 256 - core entries are a median cut of the remaining pixels (anti-aliased
edges of the mark and the text), each mapped to its nearest entry. Result ~0.21 MB. Needs Pillow + numpy; exit 3 if missing
(render.mjs then keeps the 24-bit PNG)."""
import io, sys
try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit(3)

def palettize(img, core=192, n=256):
    a = np.asarray(img.convert('RGB'))
    code = (a[..., 0].astype(np.int64) << 16) | (a[..., 1].astype(np.int64) << 8) | a[..., 2]
    u, cnt = np.unique(code, return_counts=True)
    if len(u) <= n:                                  # few colours: exact palette, nothing to approximate
        core = len(u)
    top = u[np.argsort(-cnt, kind='stable')[:core]]
    pal = np.stack([(top >> 16) & 255, (top >> 8) & 255, top & 255], -1)
    rest = ~np.isin(code, top)
    if rest.any():
        q = Image.fromarray(a[rest].reshape(-1, 1, 3)).quantize(colors=n - core, method=Image.Quantize.MEDIANCUT)
        extra = np.array(q.getpalette()[:3 * (n - core)], dtype=np.int64).reshape(-1, 3)
        pal = np.concatenate([pal, extra])
    idx = np.empty(code.size, dtype=np.uint8)
    order = np.argsort(top)
    exact, other = np.flatnonzero(~rest.ravel()), np.flatnonzero(rest.ravel())
    idx[exact] = order[np.searchsorted(top[order], code.ravel()[exact])]
    px = a.reshape(-1, 3)[other].astype(np.int64)
    for i in range(0, len(px), 65536):                # nearest palette entry (squared RGB distance)
        d = ((px[i:i + 65536, None, :] - pal[None, :, :]) ** 2).sum(-1)
        idx[other[i:i + 65536]] = d.argmin(1)
    out = Image.fromarray(idx.reshape(code.shape), 'P')
    out.putpalette(pal.astype(np.uint8).ravel().tolist() + [0] * (768 - 3 * len(pal)))
    return out

if __name__ == '__main__':
    f, core = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 192
    src = Image.open(f)
    out = palettize(src, core)
    err = int(np.abs(np.asarray(out.convert('RGB')).astype(int) - np.asarray(src.convert('RGB')).astype(int)).max())
    buf = io.BytesIO(); out.save(buf, 'PNG', optimize=True)
    open(f, 'wb').write(buf.getvalue())
    print('pngpal: %s %d B, max error %d (edges only)' % (f, len(buf.getvalue()), err))
