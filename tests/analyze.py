# Pitch-preservation + discontinuity analysis of WSOLA output vs original and ffmpeg atempo.
import wave, sys, json, os, numpy as np
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wav') + '/'   # written by tests/wsola.mjs
def load(f):
    w = wave.open(D + f); n = w.getnframes(); sr = w.getframerate()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, w.getnchannels()).astype(np.float64) / 32768
    return x.mean(axis=1), sr
def ltas(x, sr, nfft=4096):
    win = np.hanning(nfft); hop = nfft // 2
    frames = [np.abs(np.fft.rfft(win * x[i:i + nfft])) ** 2 for i in range(0, len(x) - nfft, hop)]
    return np.mean(frames, axis=0), np.fft.rfftfreq(nfft, 1 / sr)
def scale_est(xa, xb, sr):
    pa, f = ltas(xa, sr); pb, _ = ltas(xb, sr)
    lg = np.linspace(np.log2(80), np.log2(5000), 1200)          # 1/200-octave grid
    A = np.log10(np.interp(2 ** lg, f, pa) + 1e-12); B = np.log10(np.interp(2 ** lg, f, pb) + 1e-12)
    A -= A.mean(); B -= B.mean(); step = lg[1] - lg[0]; best = (-1e9, 0)
    for s in range(-160, 161):                                     # +-0.8 octave
        a = A[max(0, s):len(A) + min(0, s)]; b = B[max(0, -s):len(B) - max(0, s)]
        c = np.dot(a, b) / np.sqrt(np.dot(a, a) * np.dot(b, b))
        if c > best[0]: best = (c, s)
    return 2 ** (best[1] * step), best[0]
def f0_median(x, sr):
    fl = int(0.04 * sr); f0s = []
    for i in range(0, len(x) - fl, fl):
        fr = x[i:i + fl] - x[i:i + fl].mean()
        if np.sqrt(np.mean(fr ** 2)) < 0.01: continue
        ac = np.correlate(fr, fr, 'full')[fl - 1:]
        lo, hi = int(sr / 400), int(sr / 70)
        k = lo + np.argmax(ac[lo:hi])
        if ac[k] > 0.5 * ac[0]: f0s.append(sr / k)
    return float(np.median(f0s)) if f0s else None, len(f0s)
def clicks(x, sr):
    hp = np.diff(x); fl = int(0.004 * sr); n = len(hp) // fl
    e = np.array([np.mean(hp[i * fl:(i + 1) * fl] ** 2) for i in range(n)]) + 1e-12
    med = np.array([np.median(e[max(0, i - 12):i + 13]) for i in range(n)])
    return int(np.sum(10 * np.log10(e / med) > 15)) / (len(x) / sr / 60)
o, sr = load('orig.wav')
res = {'orig': {'f0': f0_median(o, sr), 'clicks_per_min': round(clicks(o, sr), 1)}}
for s in sys.argv[1:]:
    r = {}
    for kind in ('wsola', 'atempo'):
        x, _ = load(f'{kind}_{s}.wav')
        sc, c = scale_est(o, x, sr)
        r[kind] = {'freq_scale': round(sc, 4), 'corr': round(c, 3), 'f0': f0_median(x, sr), 'clicks_per_min': round(clicks(x, sr), 1), 'dur': round(len(x) / sr, 2)}
    res[s] = r
# naive resample control (pitch NOT preserved) at 1.5x
idx = np.arange(0, len(o) - 1, 1.5); naive = np.interp(idx, np.arange(len(o)), o)
res['naive_resample_1.5_scale'] = round(scale_est(o, naive, sr)[0], 3)
x, _ = load('wsola_1.5_modulated.wav'); res['wsola_1.5_modulated'] = {'freq_scale': round(scale_est(o, x, sr)[0], 4), 'clicks_per_min': round(clicks(x, sr), 1)}
print(json.dumps(res, indent=1))
