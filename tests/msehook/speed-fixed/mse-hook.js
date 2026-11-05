import {
  classifyMp4,
  rewriteInitTimescale,
  parseInitInfo,
  audioConfigFromInit,
  demuxFragments,
  parseBoxes,
  classifyWebm,
  rewriteTimecodeScale,
  findTimecodeScale,
  audioConfigFromWebmInit,
  demuxClusters,
  parseElements,
  trackHandlers
} from './containers.js';

export const SUPPORTED_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function isSupportedSpeed(speed) {
  return SUPPORTED_SPEEDS.includes(speed);
}

// A video/* type whose codecs also name an audio codec: one SourceBuffer for
// both tracks (hls.js uses one 'audiovideo' buffer for muxed fMP4). Its audio
// cannot go through the fake audio SourceBuffer, and a natively decoded audio
// track on a timeline scaled by S plays at the wrong rate and drifts.
export function isMuxedAudioVideo(mime) {
  if (!/^\s*video\//i.test(mime)) return false;
  const m = /codecs\s*=\s*"?([^";]*)/i.exec(mime);
  if (!m) return false;
  return m[1]
    .split(',')
    .some((c) => /^(mp4a|opus|ac-3|ec-3|ac-4|flac|vorbis|mp3|dts)/i.test(c.trim()));
}

function domError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

// Decoder configs as produced by audioConfigFromInit/audioConfigFromWebmInit.
function sameAudioConfig(a, b) {
  if (!a || !b) return false;
  if (
    a.codec !== b.codec ||
    a.sampleRate !== b.sampleRate ||
    a.numberOfChannels !== b.numberOfChannels
  )
    return false;
  const da = a.description ? new Uint8Array(a.description) : null;
  const db = b.description ? new Uint8Array(b.description) : null;
  if (!da || !db) return da === db;
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}

export class SpeedTimeMap {
    constructor(speed) {
    this._speed = 1;
    this.speed = speed;
  }

    get speed() {
    return this._speed;
  }

    set speed(value) {
    if (!isSupportedSpeed(value)) {
      throw new TypeError(`Unsupported speed: ${value}`);
    }
    this._speed = value;
  }

    toElement(t) {
    return t / this._speed;
  }

    toContent(t) {
    return t * this._speed;
  }

    mapRanges(ranges, direction) {
    const mapFn =
      direction === 'toContent'
        ? (t) => this.toContent(t)
        : (t) => this.toElement(t);
    return {
      length: ranges.length,
      start(i) {
        if (i < 0 || i >= this.length)
          throw new RangeError('Index out of bounds');
        return mapFn(ranges.start(i));
      },
      end(i) {
        if (i < 0 || i >= this.length)
          throw new RangeError('Index out of bounds');
        return mapFn(ranges.end(i));
      }
    };
  }
}

export function attachElementShim(el, timeMap, { onRateRequest }) {
  if (timeMap.speed === 1) return { detach: () => {}, isAttached: () => false };

  const originals = {};

  const defineProp = (prop, get, set) => {
    let proto = el;
    let desc;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, prop))) {
      proto = Object.getPrototypeOf(proto);
    }
    if (desc) {
      originals[prop] = desc;
      const newDesc = {
        configurable: true,
        enumerable: true,
        get: get
          ? function () {
              return get.call(this, desc.get);
            }
          : function () {
              return desc.get.call(this);
            }
      };
      if (set) {
        newDesc.set = function (val) {
          set.call(this, val, desc.set);
        };
      }
      Object.defineProperty(el, prop, newDesc);
    }
  };

  const mapRanges = (ranges) => ({
    length: ranges.length,
    start: (i) => timeMap.toContent(ranges.start(i)),
    end: (i) => timeMap.toContent(ranges.end(i))
  });

  defineProp(
    'currentTime',
    function (origGet) {
      return timeMap.toContent(origGet.call(this));
    },
    function (val, origSet) {
      origSet.call(this, timeMap.toElement(val));
    }
  );

  defineProp('duration', function (origGet) {
    const d = origGet.call(this);
    return isNaN(d) ? d : timeMap.toContent(d);
  });

  defineProp('buffered', function (origGet) {
    return mapRanges(origGet.call(this));
  });

  defineProp('seekable', function (origGet) {
    return mapRanges(origGet.call(this));
  });

  defineProp(
    'playbackRate',
    function () {
      return timeMap.speed;
    },
    function (val, _origSet) {
      if (onRateRequest) onRateRequest(val);
    }
  );

  const initialSrc = el.src;

  defineProp('src', null, function (val, origSet) {
    origSet.call(this, val);
    if (val !== initialSrc) {
      detach();
    }
  });

  let detached = false;
  function detach() {
    if (detached) return;
    detached = true;
    for (const prop of Object.keys(originals)) {
      // Actually we just delete the own properties to fallback to prototype chain
      delete el[prop];
    }
  }

  return { detach, isAttached: () => !detached };
}

export function installMseHook(
  win,
  { getSpeed, createAudioSink, onRateRequest, onError, onNativeAudio }
) {
  const origAddSourceBuffer = win.MediaSource.prototype.addSourceBuffer;
  const origRemoveSourceBuffer = win.MediaSource.prototype.removeSourceBuffer;
  const origCreateObjectURL = win.URL.createObjectURL;
  const origSrcDesc = Object.getOwnPropertyDescriptor(
    win.HTMLMediaElement.prototype,
    'src'
  );

  const sessions = new WeakMap();
  const urlToMs = new Map();
  const msToEl = new WeakMap();
  const elToShim = new WeakMap();
  // The speed is decided once, at the first addSourceBuffer of a MediaSource,
  // and remembered even when it is 1: a later change of getSpeed() must not
  // turn half of the SourceBuffers of the same MediaSource into fakes.
  const decided = new WeakMap();

  // Attaching twice would stack two shims (x S^2): reuse a live one for the
  // same session, replace one that belongs to another session.
  function attach(el, session) {
    const cur = elToShim.get(el);
    if (cur && cur.session === session && cur.shim.isAttached()) return;
    if (cur && cur.shim.isAttached()) cur.shim.detach();
    const shim = attachElementShim(el, session.timeMap, { onRateRequest });
    elToShim.set(el, { shim, session });
  }

  win.URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof win.MediaSource) {
      urlToMs.set(url, obj);
    }
    return url;
  };

  if (origSrcDesc) {
    Object.defineProperty(win.HTMLMediaElement.prototype, 'src', {
      get() {
        return origSrcDesc.get.call(this);
      },
      set(val) {
        const ms = urlToMs.get(val);
        if (ms) {
          msToEl.set(ms, this);
          const session = sessions.get(ms);
          if (session) attach(this, session);
        }
        origSrcDesc.set.call(this, val);
      }
    });
  }

  win.MediaSource.prototype.addSourceBuffer = function (mime) {
    if (!decided.has(this)) {
      let speed = getSpeed();
      if (speed !== 1.0 && isMuxedAudioVideo(mime)) {
        // Muxed audio+video: play this MediaSource at 1x (and say so) rather
        // than build a timeline that its native audio track cannot follow.
        speed = 1.0;
        if (onError) onError(new Error(`muxed audio/video SourceBuffer: ${mime}`));
      }
      decided.set(this, speed);
      // A MediaSource at 1x plays the native audio: whatever engine the previous
      // one had must stop now, or both are heard.
      if (decided.get(this) === 1.0 && onNativeAudio) onNativeAudio();
    }
    const speed = decided.get(this);
    if (speed === 1.0) {
      return origAddSourceBuffer.call(this, mime);
    }

    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');

    let session = sessions.get(this);
    if (!session) {
      session = {
        speed,
        audio: null,
        video: null,
        timeMap: new SpeedTimeMap(speed)
      };
      sessions.set(this, session);
      patchMediaSource(this, session);

      const el = msToEl.get(this);
      if (el) attach(el, session);
    }

    if (isVideo) {
      const realSb = origAddSourceBuffer.call(this, mime);
      patchVideoSourceBuffer(realSb, mime, speed, onError);
      session.video = realSb;
      return realSb;
    } else if (isAudio) {
      const sink = createAudioSink({
        speed,
        element: msToEl.get(this) || null
      });
      const fakeSb = new FakeAudioSourceBuffer(win, mime, speed, sink, onError);
      session.audio = fakeSb;
      return fakeSb;
    } else {
      return origAddSourceBuffer.call(this, mime);
    }
  };

  // The fake audio buffer is listed in ms.sourceBuffers, so players hand it
  // back here (hls.js on detach/recoverMediaError, YouTube on format change).
  // The native method throws a TypeError for it, and its engine kept running.
  win.MediaSource.prototype.removeSourceBuffer = function (sb) {
    if (sb instanceof FakeAudioSourceBuffer) {
      const session = sessions.get(this);
      if (!session || session.audio !== sb) {
        throw domError('NotFoundError', 'SourceBuffer is not in this MediaSource');
      }
      session.audio = null;
      sb._detach();
      return undefined;
    }
    return origRemoveSourceBuffer.call(this, sb);
  };

  function patchMediaSource(ms, session) {
    let origDurationDesc = Object.getOwnPropertyDescriptor(ms, 'duration');
    if (!origDurationDesc) {
      origDurationDesc = Object.getOwnPropertyDescriptor(
        win.MediaSource.prototype,
        'duration'
      );
    }
    if (origDurationDesc) {
      Object.defineProperty(ms, 'duration', {
        get() {
          const val = origDurationDesc.get.call(this);
          return isNaN(val) ? val : val * session.speed;
        },
        set(val) {
          origDurationDesc.set.call(this, val / session.speed);
        }
      });
    }

    let origSourceBuffersDesc = Object.getOwnPropertyDescriptor(
      ms,
      'sourceBuffers'
    );
    if (!origSourceBuffersDesc) {
      origSourceBuffersDesc = Object.getOwnPropertyDescriptor(
        win.MediaSource.prototype,
        'sourceBuffers'
      );
    }
    if (origSourceBuffersDesc) {
      Object.defineProperty(ms, 'sourceBuffers', {
        get() {
          const realSbList = origSourceBuffersDesc.get.call(this);
          const list = {
            length: realSbList.length + (session.audio ? 1 : 0),
            item(idx) {
              if (idx < realSbList.length) return realSbList.item(idx);
              if (idx === realSbList.length && session.audio)
                return session.audio;
              return undefined;
            }
          };
          for (let i = 0; i < realSbList.length; i++) {
            list[i] = realSbList[i];
          }
          if (session.audio) {
            list[realSbList.length] = session.audio;
          }
          return list;
        }
      });
    }
  }

  function looksLikeInitStart(u8) {
    if (
      u8.length >= 4 &&
      u8[0] === 0x1a &&
      u8[1] === 0x45 &&
      u8[2] === 0xdf &&
      u8[3] === 0xa3
    )
      return true;
    if (u8.length >= 8) {
      const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      return t === 'ftyp' || t === 'moov';
    }
    return false;
  }

  function patchVideoSourceBuffer(sb, mime, speed, onError) {
    const origAppendBuffer = sb.appendBuffer;
    const origRemove = sb.remove;

    const isMp4 = mime.includes('mp4');
    const isWebm = mime.includes('webm');

    sb.appendBuffer = function (data) {
      // Only the rewrite may fail here. The native append runs exactly once,
      // outside the try: its own errors (QuotaExceededError when the buffer is
      // full, InvalidStateError) belong to the player, which handles them. They
      // used to be caught, reported as a speed failure (fallback to 1x and a
      // reload) and then the same data was appended a second time.
      let toAppend = data;
      let problem = null;
      try {
        const u8 = new Uint8Array(data);
        let isInit = false;
        if (isMp4) {
          const type = classifyMp4(u8);
          if (type === 'init' || type === 'init+media') isInit = true;
        } else if (isWebm) {
          const type = classifyWebm(u8);
          if (type === 'init' || type === 'init+media') isInit = true;
        }

        if (isInit) {
          if (isMp4) {
            toAppend = rewriteInitTimescale(u8, speed).data;
            if (trackHandlers(u8).includes('soun')) {
              problem = new Error('audio track inside the video SourceBuffer');
            }
          } else if (isWebm) {
            toAppend = rewriteTimecodeScale(new Uint8Array(u8), speed).data;
          }
        } else if (looksLikeInitStart(u8)) {
          // An init we cannot see whole cannot be rewritten: the video would
          // play at 1x while the audio is stretched. Say so; B2 falls back to 1x.
          problem = new Error('init segment split across appends');
        }
      } catch (e) {
        problem = e;
        toAppend = data;
      }
      if (problem && onError) onError(problem);
      return origAppendBuffer.call(this, toAppend);
    };

    sb.remove = function (start, end) {
      origRemove.call(this, start / speed, end / speed);
    };

    const defineAccessor = (prop, scale) => {
      let desc = Object.getOwnPropertyDescriptor(sb, prop);
      let proto = sb;
      while (!desc && proto) {
        proto = Object.getPrototypeOf(proto);
        desc = Object.getOwnPropertyDescriptor(proto, prop);
      }
      if (!desc) return;
      Object.defineProperty(sb, prop, {
        get() {
          const val = desc.get.call(this);
          return val * scale;
        },
        set(val) {
          desc.set.call(this, val / scale);
        }
      });
    };

    defineAccessor('timestampOffset', speed);

    // appendWindowEnd = Infinity resta Infinity
    // Infinity / 1.5 = Infinity, Infinity * 1.5 = Infinity, so the generic accessor works.
    defineAccessor('appendWindowStart', speed);
    defineAccessor('appendWindowEnd', speed);

    let descBuf = Object.getOwnPropertyDescriptor(sb, 'buffered');
    let protoBuf = sb;
    while (!descBuf && protoBuf) {
      protoBuf = Object.getPrototypeOf(protoBuf);
      descBuf = Object.getOwnPropertyDescriptor(protoBuf, 'buffered');
    }
    if (descBuf) {
      Object.defineProperty(sb, 'buffered', {
        get() {
          const origBuf = descBuf.get.call(this);
          return {
            length: origBuf.length,
            start: (i) => origBuf.start(i) * speed,
            end: (i) => origBuf.end(i) * speed
          };
        }
      });
    }
  }

  function uninstall() {
    win.MediaSource.prototype.addSourceBuffer = origAddSourceBuffer;
    win.MediaSource.prototype.removeSourceBuffer = origRemoveSourceBuffer;
    win.URL.createObjectURL = origCreateObjectURL;
    if (origSrcDesc) {
      Object.defineProperty(win.HTMLMediaElement.prototype, 'src', origSrcDesc);
    }
  }

  const MAX_REST = 4 * 1024 * 1024;

  class FakeAudioSourceBuffer extends win.EventTarget {
    constructor(win, mime, speed, sink, onError) {
      super();
      this.win = win;
      this.mime = mime;
      this.speed = speed;
      this.sink = sink;
      this.onError = onError;

      this.isMp4 = mime.includes('mp4');
      this.isWebm = mime.includes('webm');
      this.updating = false;
      this._timestampOffset = 0;
      this.rest = new Uint8Array(0);
      this.initInfo = null;
      this.bufferedRanges = [];
      this.removed = false;
      this.lastCfg = null;

      this.onupdateend = null;
      this.onerror = null;
      this._gen = 0;
    }

    get timestampOffset() {
      return this._timestampOffset;
    }
    set timestampOffset(val) {
      this._timestampOffset = val;
    }

    get buffered() {
      if (this.bufferedRanges.length === 0) {
        return { length: 0, start: () => 0, end: () => 0 };
      }
      return {
        length: this.bufferedRanges.length,
        start: (i) => {
          if (i < 0 || i >= this.bufferedRanges.length)
            throw new RangeError('Index out of bounds');
          return this.bufferedRanges[i].start;
        },
        end: (i) => {
          if (i < 0 || i >= this.bufferedRanges.length)
            throw new RangeError('Index out of bounds');
          return this.bufferedRanges[i].end;
        }
      };
    }

    _addRange(start, end) {
      this.bufferedRanges.push({ start, end });
      this.bufferedRanges.sort((a, b) => a.start - b.start);
      const merged = [];
      for (const r of this.bufferedRanges) {
        if (merged.length === 0) {
          merged.push(r);
        } else {
          const last = merged[merged.length - 1];
          if (r.start <= last.end + 0.001) {
            last.end = Math.max(last.end, r.end);
          } else {
            merged.push(r);
          }
        }
      }
      this.bufferedRanges = merged;
    }

    appendBuffer(data) {
      if (this.removed) {
        throw domError('InvalidStateError', 'SourceBuffer has been removed');
      }
      if (this.updating) {
        const err = new Error('InvalidStateError');
        err.name = 'InvalidStateError';
        throw err;
      }
      this.updating = true;
      this.dispatchEvent(new win.Event('updatestart'));

      const chunk = new Uint8Array(data);
      const u8 = new Uint8Array(this.rest.length + chunk.length);
      u8.set(this.rest, 0);
      u8.set(chunk, this.rest.length);

      try {
        if (this.isMp4) {
          const type = classifyMp4(u8);
          const moov = parseBoxes(u8, 0, u8.length).find(
            (b) => b.type === 'moov'
          );
          if (moov && moov.truncated) {
            this.rest = u8; // the init continues in the next append
          } else if (type === 'init' || type === 'init+media') {
            const cfg = audioConfigFromInit(u8);
            if (cfg.unsupported) {
              const err = new Error('Unsupported audio');
              err.name = 'NotSupportedError';
              throw err;
            }
            this._configure(cfg);
            this.initInfo = parseInitInfo(u8);
            if (type === 'init+media') {
              const res = demuxFragments(u8, this.initInfo);
              this.rest = res.rest;
              if (res.samples.length > 0) {
                const adjusted = res.samples.map((s) => ({
                  ...s,
                  pts: s.pts + this._timestampOffset
                }));
                this.sink.push(adjusted);
                const start = adjusted[0].pts;
                const end =
                  adjusted[adjusted.length - 1].pts +
                  adjusted[adjusted.length - 1].duration;
                this._addRange(start, end);
              }
            } else {
              let nextBoxOffset = 0;
              const boxes = parseBoxes(u8, 0, u8.length);
              if (boxes.length > 0) {
                nextBoxOffset = boxes[boxes.length - 1].end;
              }
              if (boxes[boxes.length - 1].truncated) {
                this.rest = u8.subarray(boxes[boxes.length - 1].start);
              } else {
                this.rest = u8.subarray(nextBoxOffset);
              }
            }
          } else if (type === 'media' && this.initInfo) {
            const res = demuxFragments(u8, this.initInfo);
            this.rest = res.rest;
            if (res.samples.length > 0) {
              const adjusted = res.samples.map((s) => ({
                ...s,
                pts: s.pts + this._timestampOffset
              }));
              this.sink.push(adjusted);
              const start = adjusted[0].pts;
              const end =
                adjusted[adjusted.length - 1].pts +
                adjusted[adjusted.length - 1].duration;
              this._addRange(start, end);
            }
          } else {
            this.rest = u8;
          }
        } else if (this.isWebm) {
          const type = classifyWebm(u8);
          if (type === 'init' || type === 'init+media') {
            const cfg = audioConfigFromWebmInit(u8);
            if (cfg.unsupported) {
              const err = new Error('Unsupported audio');
              err.name = 'NotSupportedError';
              throw err;
            }
            this._configure(cfg);
            const tcScaleObj = findTimecodeScale(u8);
            this.initInfo = {
              timecodeScale: tcScaleObj ? tcScaleObj.value : 1000000,
              trackNumber: cfg.trackNumber
            };
            if (type === 'init+media') {
              const res = demuxClusters(u8, this.initInfo);
              this.rest = res.rest;
              if (res.frames && res.frames.length > 0) {
                for (let i = 0; i < res.frames.length; i++) {
                  if (i < res.frames.length - 1) {
                    res.frames[i].duration =
                      res.frames[i + 1].pts - res.frames[i].pts;
                  } else {
                    res.frames[i].duration =
                      i > 0 && res.frames[i - 1].duration > 0
                        ? res.frames[i - 1].duration
                        : 0.02;
                  }
                }
                const adjusted = res.frames.map((f) => ({
                  ...f,
                  pts: f.pts + this._timestampOffset
                }));
                this.sink.push(adjusted);
                const start = adjusted[0].pts;
                const end =
                  adjusted[adjusted.length - 1].pts +
                  adjusted[adjusted.length - 1].duration;
                this._addRange(start, end);
              }
            } else {
              let nextOffset = 0;
              const elements = parseElements(u8, 0, u8.length);
              if (elements.length > 0) {
                nextOffset = elements[elements.length - 1].end;
                if (elements[elements.length - 1].truncated) {
                  this.rest = u8.subarray(elements[elements.length - 1].start);
                } else {
                  this.rest = u8.subarray(nextOffset);
                }
              } else {
                this.rest = new Uint8Array(0);
              }
            }
          } else if (type === 'media' && this.initInfo) {
            const res = demuxClusters(u8, this.initInfo);
            this.rest = res.rest;
            if (res.frames && res.frames.length > 0) {
              for (let i = 0; i < res.frames.length; i++) {
                if (i < res.frames.length - 1) {
                  res.frames[i].duration =
                    res.frames[i + 1].pts - res.frames[i].pts;
                } else {
                  res.frames[i].duration =
                    i > 0 && res.frames[i - 1].duration > 0
                      ? res.frames[i - 1].duration
                      : 0.02;
                }
              }
              const adjusted = res.frames.map((f) => ({
                ...f,
                pts: f.pts + this._timestampOffset
              }));
              this.sink.push(adjusted);
              const start = adjusted[0].pts;
              const end =
                adjusted[adjusted.length - 1].pts +
                adjusted[adjusted.length - 1].duration;
              this._addRange(start, end);
            }
          } else {
            this.rest = u8;
          }
        }
      } catch (e) {
        this.rest = new Uint8Array(0);
        if (this.onError) this.onError(e);
      }
      if (this.rest.length > MAX_REST) {
        // Never grow without bound on data we cannot parse.
        this.rest = new Uint8Array(0);
        if (this.onError) this.onError(new Error('unparsable audio data'));
      }

      this._finishLater();
    }

    // Every init goes through here. Same decoder config (the usual case, also
    // after changeType() between renditions): nothing is dropped. A different
    // one: the frames queued for the old decoder cannot be decoded by the new
    // one, so the sink drops them, and `buffered` drops them too, so that the
    // player fetches that range again instead of trusting audio that is gone.
    _configure(cfg) {
      if (this.lastCfg && !sameAudioConfig(this.lastCfg, cfg)) {
        this.sink.reset();
        this.bufferedRanges = [];
      }
      this.lastCfg = cfg;
      this.sink.configure(cfg);
    }

    _finishLater() {
      // Real SourceBuffers end an update asynchronously; an abort() in between
      // ends it right away, and this late callback must then do nothing.
      const gen = ++this._gen;
      Promise.resolve().then(() => {
        if (gen !== this._gen || !this.updating) return;
        this.dispatchEvent(new win.Event('update'));
        this.updating = false;
        const e = new win.Event('updateend');
        this.dispatchEvent(e);
        if (this.onupdateend) this.onupdateend(e);
      });
    }

    remove(start, end) {
      if (this.removed) {
        throw domError('InvalidStateError', 'SourceBuffer has been removed');
      }
      if (this.updating) {
        const err = new Error('InvalidStateError');
        err.name = 'InvalidStateError';
        throw err;
      }
      this.updating = true;
      this.dispatchEvent(new win.Event('updatestart'));

      this.sink.discard(start, end);

      const result = [];
      for (const r of this.bufferedRanges) {
        if (r.end <= start || r.start >= end) {
          result.push(r);
        } else {
          if (r.start < start) {
            result.push({ start: r.start, end: start });
          }
          if (r.end > end) {
            result.push({ start: end, end: r.end });
          }
        }
      }
      this.bufferedRanges = result;
      this._finishLater();
    }

    abort() {
      this.rest = new Uint8Array(0);
      if (this.updating) {
        this._gen++;
        this.updating = false;
        const eAbort = new win.Event('abort');
        this.dispatchEvent(eAbort);
        if (this.onabort) this.onabort(eAbort);
        const eUpdateEnd = new win.Event('updateend');
        this.dispatchEvent(eUpdateEnd);
        if (this.onupdateend) this.onupdateend(eUpdateEnd);
      }
    }

    changeType(type) {
      if (this.removed || this.updating) {
        throw domError('InvalidStateError', 'changeType() not allowed now');
      }
      if (typeof type !== 'string' || type === '') {
        throw new TypeError('changeType() needs a MIME type');
      }
      const wasMp4 = this.isMp4;
      this.mime = type;
      this.isMp4 = type.includes('mp4');
      this.isWebm = type.includes('webm');
      // MSE keeps every buffered frame across changeType() and only resets the
      // parser: the next append starts with an init segment. This used to reset
      // the sink too: the decoded and queued audio vanished while `buffered`
      // still listed it, so the player never fetched it again -> silence and
      // re-anchoring until the playhead left the stale range. The sink is now
      // only reset by _configure(), if the next init really changes the codec.
      this.rest = new Uint8Array(0);
      if (this.isMp4 !== wasMp4) this.initInfo = null;
    }

    // MediaSource.removeSourceBuffer(): stop the engine of this buffer.
    _detach() {
      this.abort();
      this.removed = true;
      this.bufferedRanges = [];
      this.rest = new Uint8Array(0);
      if (typeof this.sink.destroy === 'function') this.sink.destroy();
      else this.sink.reset();
    }
  }
  return { uninstall };
}
