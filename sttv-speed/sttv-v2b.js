/*! sttv-v2b.js 1.3.8 - MSE timeline-compression hook for sttv-speed (window.STTVMseHook), loaded on demand.
 * Derived from webosbrew/youtube-webos (schmiddisen speed fork) src/speed/mse-hook.js + containers.js - GPL-3.0-only.
 * Changes: see mse-fix/yt-speed-mse-hook-fixes.patch (re-timing fixes) + entry wrapper; built with esbuild (IIFE, chrome68).
 * 1.3.1: ES2015 syntax only (object spread -> Object.assign, ** -> Math.pow), so it also parses on Chromium 53 (webOS 4.x).
 * 1.3.2: MediaSource.duration set BEFORE the first addSourceBuffer() (hls.js does it on 'sourceopen' / LEVEL_UPDATED) is
 *        rebased to element time when the session starts - it reached the native setter unscaled, so element.duration
 *        (shim) read S x the real VOD length until endOfStream(). Hook stats (sessions / rebases) for diagnostics.
 * 1.3.8: memory leak - the url -> MediaSource map kept every MediaSource of the page alive (+2 per v2b engage + respeed);
 *        entries now go on URL.revokeObjectURL and the map is capped at 8 (stats.urlMap). */
(() => {
  // v2b/src/containers.js
  function parseBoxes(u8, start, end) {
    const boxes = [];
    let i = start;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (i < end) {
      if (i + 8 > end) {
        boxes.push({
          type: "",
          start: i,
          headerSize: 0,
          size: 0,
          end,
          truncated: true
        });
        break;
      }
      let size = view.getUint32(i);
      let type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (i + 16 > end) {
          boxes.push({
            type,
            start: i,
            headerSize: 16,
            size: 1,
            end,
            truncated: true
          });
          break;
        }
        const hi = view.getUint32(i + 8);
        const lo = view.getUint32(i + 12);
        if (hi > 2097151) throw new Error("Size exceeds MAX_SAFE_INTEGER");
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (i + size > end || size < headerSize) {
        boxes.push({ type, start: i, headerSize, size, end, truncated: true });
        break;
      }
      boxes.push({
        type,
        start: i,
        headerSize,
        size,
        end: i + size,
        truncated: false
      });
      i += size;
    }
    return boxes;
  }
  function classifyMp4(u8) {
    const boxes = parseBoxes(u8, 0, u8.length);
    const types = new Set(boxes.map((b) => b.type));
    if (types.has("moov") && types.has("moof")) return "init+media";
    if (types.has("moov")) return "init";
    if (types.has("moof")) return "media";
    return "unknown";
  }
  function dfs(u8, start, end, target) {
    const boxes = parseBoxes(u8, start, end);
    for (const box of boxes) {
      if (box.type === target) return box;
      if (["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"].includes(
        box.type
      )) {
        if (!box.truncated) {
          const res = dfs(u8, box.start + box.headerSize, box.end, target);
          if (res) return res;
        }
      }
    }
    return null;
  }
  function dfsAll(u8, start, end, target, out = []) {
    const boxes = parseBoxes(u8, start, end);
    for (const box of boxes) {
      if (box.type === target) {
        out.push(box);
      } else if (["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"].includes(
        box.type
      ) && !box.truncated) {
        dfsAll(u8, box.start + box.headerSize, box.end, target, out);
      }
    }
    return out;
  }
  function timescaleOffset(view, box) {
    const version = view.getUint8(box.start + box.headerSize);
    return box.start + box.headerSize + 4 + (version === 1 ? 16 : 8);
  }
  function trackHandlers(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return dfsAll(u8, 0, u8.length, "hdlr").filter((b) => !b.truncated && b.end - b.start >= b.headerSize + 12).map((b) => {
      const p = b.start + b.headerSize + 8;
      return String.fromCharCode(
        view.getUint8(p),
        view.getUint8(p + 1),
        view.getUint8(p + 2),
        view.getUint8(p + 3)
      );
    });
  }
  function findMdhdTimescale(u8) {
    const mdhd = dfs(u8, 0, u8.length, "mdhd");
    if (!mdhd || mdhd.truncated) return null;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = view.getUint8(mdhd.start + mdhd.headerSize);
    let offset = mdhd.start + mdhd.headerSize + 4;
    if (version === 1) {
      offset += 16;
    } else {
      offset += 8;
    }
    const timescale = view.getUint32(offset);
    return { offset, version, timescale };
  }
  function rewriteInitTimescale(u8, speed) {
    const data = new Uint8Array(u8);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const mdhds = dfsAll(data, 0, data.length, "mdhd");
    if (mdhds.length === 0 || mdhds.some((b) => b.truncated)) {
      throw new RangeError("mdhd not found");
    }
    let relativeError = 0;
    const scaleAt = (box, what) => {
      const offset = timescaleOffset(view, box);
      const original = view.getUint32(offset);
      const exact = original * speed;
      const scaled = Math.round(exact);
      if (!original || scaled < 1 || scaled > 4294967295) {
        throw new RangeError(`${what} timescale ${original} cannot be scaled`);
      }
      view.setUint32(offset, scaled);
      relativeError = Math.max(relativeError, Math.abs(scaled - exact) / exact);
      return { original, scaled };
    };
    const tracks = mdhds.map((b) => scaleAt(b, "mdhd"));
    const mvhd = dfs(data, 0, data.length, "mvhd");
    const movie = mvhd && !mvhd.truncated ? scaleAt(mvhd, "mvhd") : null;
    return {
      data,
      original: tracks[0].original,
      scaled: tracks[0].scaled,
      tracks,
      movie,
      relativeError
    };
  }
  function readDescr(view, start, end) {
    let p = start;
    if (p >= end) return null;
    const tag = view.getUint8(p++);
    let len = 0;
    let b;
    do {
      if (p >= end) return null;
      b = view.getUint8(p++);
      len = len << 7 | b & 127;
    } while (b & 128);
    return { tag, len, start: p, end: p + len };
  }
  function opusHeadFromDOps(d) {
    const src = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const out = new Uint8Array(19 + Math.max(0, d.length - 11));
    const dst = new DataView(out.buffer);
    out.set([79, 112, 117, 115, 72, 101, 97, 100], 0);
    out[8] = 1;
    out[9] = d[1];
    dst.setUint16(10, src.getUint16(2), true);
    dst.setUint32(12, src.getUint32(4), true);
    dst.setInt16(16, src.getInt16(8), true);
    out[18] = d[10];
    out.set(d.subarray(11), 19);
    return out;
  }
  function parseInitInfo(u8) {
    const ts = findMdhdTimescale(u8);
    if (!ts) return null;
    const trexBox = dfs(u8, 0, u8.length, "trex");
    let trex;
    if (trexBox && !trexBox.truncated) {
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const p = trexBox.start + trexBox.headerSize + 4;
      trex = {
        defaultDuration: view.getUint32(p + 8),
        defaultSize: view.getUint32(p + 12),
        defaultFlags: view.getUint32(p + 16)
      };
    }
    return { timescale: ts.timescale, trex };
  }
  function audioConfigFromInit(u8) {
    const stsd = dfs(u8, 0, u8.length, "stsd");
    if (!stsd || stsd.truncated) return { unsupported: true };
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = stsd.start + stsd.headerSize + 8;
    const entries = parseBoxes(u8, offset, stsd.end);
    for (const entry of entries) {
      if (entry.type === "mp4a") {
        const channelCount = view.getUint16(entry.start + entry.headerSize + 16);
        const sampleRate = view.getUint32(entry.start + entry.headerSize + 24) >>> 16;
        const esds = dfs(
          u8,
          entry.start + entry.headerSize + 28,
          entry.end,
          "esds"
        );
        if (esds) {
          let p = esds.start + esds.headerSize + 4;
          let esDescr = readDescr(view, p, esds.end);
          if (esDescr && esDescr.tag === 3) {
            let decConfStart = esDescr.start + 3;
            let decConf = readDescr(view, decConfStart, esDescr.end);
            if (decConf && decConf.tag === 4) {
              let decSpecStart = decConf.start + 13;
              let decSpec = readDescr(view, decSpecStart, decConf.end);
              if (decSpec && decSpec.tag === 5) {
                const description = new Uint8Array(
                  u8.buffer,
                  u8.byteOffset + decSpec.start,
                  decSpec.len
                );
                const aot = description.length ? description[0] >> 3 : 2;
                return {
                  codec: `mp4a.40.${aot}`,
                  sampleRate,
                  numberOfChannels: channelCount,
                  description
                };
              }
            }
          }
        }
      } else if (entry.type === "Opus") {
        const channelCount = view.getUint16(entry.start + entry.headerSize + 16);
        const dOps = dfs(
          u8,
          entry.start + entry.headerSize + 28,
          entry.end,
          "dOps"
        );
        if (dOps) {
          return {
            codec: "opus",
            sampleRate: 48e3,
            numberOfChannels: channelCount,
            description: opusHeadFromDOps(
              u8.subarray(dOps.start + dOps.headerSize, dOps.end)
            )
          };
        }
      } else if (entry.type === "avc1" || entry.type === "av01" || entry.type === "vp09") {
        return { unsupported: true, codec: entry.type };
      }
    }
    return { unsupported: true };
  }
  function demuxFragments(u8, { timescale, trex }) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const samples = [];
    const boxes = parseBoxes(u8, 0, u8.length);
    let restStart = u8.length;
    const defaultDuration = trex ? trex.defaultDuration : 0;
    const defaultSize = trex ? trex.defaultSize : 0;
    const defaultFlags = trex ? trex.defaultFlags : 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.truncated && box.type !== "moof") {
        restStart = Math.min(restStart, box.start);
        continue;
      }
      if (box.type === "moof") {
        if (box.truncated) {
          restStart = Math.min(restStart, box.start);
          continue;
        }
        const trafBoxes = parseBoxes(
          u8,
          box.start + box.headerSize,
          box.end
        ).filter((b) => b.type === "traf");
        let moofValid = true;
        let moofSamples = [];
        for (const traf of trafBoxes) {
          const trBoxes = parseBoxes(u8, traf.start + traf.headerSize, traf.end);
          const tfhd = trBoxes.find((b) => b.type === "tfhd");
          const tfdt = trBoxes.find((b) => b.type === "tfdt");
          const trunList = trBoxes.filter((b) => b.type === "trun");
          let baseDataOffset = box.start;
          let trafDefaultDuration = defaultDuration;
          let trafDefaultSize = defaultSize;
          let trafDefaultFlags = defaultFlags;
          if (tfhd) {
            const flags = view.getUint32(tfhd.start + tfhd.headerSize) & 16777215;
            let p = tfhd.start + tfhd.headerSize + 8;
            if (flags & 1) {
              const hi = view.getUint32(p);
              const lo = view.getUint32(p + 4);
              baseDataOffset = hi * 4294967296 + lo;
              p += 8;
            } else if (flags & 131072) {
              baseDataOffset = box.start;
            }
            if (flags & 2) p += 4;
            if (flags & 8) {
              trafDefaultDuration = view.getUint32(p);
              p += 4;
            }
            if (flags & 16) {
              trafDefaultSize = view.getUint32(p);
              p += 4;
            }
            if (flags & 32) {
              trafDefaultFlags = view.getUint32(p);
            }
          }
          let currentDecodeTime = 0;
          if (tfdt) {
            const version = view.getUint8(tfdt.start + tfdt.headerSize);
            if (version === 1) {
              const hi = view.getUint32(tfdt.start + tfdt.headerSize + 4);
              const lo = view.getUint32(tfdt.start + tfdt.headerSize + 8);
              currentDecodeTime = hi * 4294967296 + lo;
            } else {
              currentDecodeTime = view.getUint32(
                tfdt.start + tfdt.headerSize + 4
              );
            }
          }
          for (const trun of trunList) {
            const version = view.getUint8(trun.start + trun.headerSize);
            const flags = view.getUint32(trun.start + trun.headerSize) & 16777215;
            let p = trun.start + trun.headerSize + 4;
            const sampleCount = view.getUint32(p);
            p += 4;
            let dataOffset = 0;
            if (flags & 1) {
              dataOffset = view.getInt32(p);
              p += 4;
            }
            let firstSampleFlags = 0;
            if (flags & 4) {
              firstSampleFlags = view.getUint32(p);
              p += 4;
            }
            let trunDataOffset = baseDataOffset + dataOffset;
            for (let s = 0; s < sampleCount; s++) {
              let duration = trafDefaultDuration;
              let size = trafDefaultSize;
              let sampleFlags = s === 0 && flags & 4 ? firstSampleFlags : trafDefaultFlags;
              let cto = 0;
              if (flags & 256) {
                duration = view.getUint32(p);
                p += 4;
              }
              if (flags & 512) {
                size = view.getUint32(p);
                p += 4;
              }
              if (flags & 1024) {
                sampleFlags = view.getUint32(p);
                p += 4;
              }
              if (flags & 2048) {
                cto = version === 1 ? view.getInt32(p) : view.getUint32(p);
                p += 4;
              }
              const isNonSync = sampleFlags >> 16 & 1;
              const key = isNonSync === 0;
              const pts = (currentDecodeTime + cto) / timescale;
              const durSec = duration / timescale;
              if (trunDataOffset + size > u8.length) {
                moofValid = false;
                break;
              }
              const data = new Uint8Array(
                u8.buffer,
                u8.byteOffset + trunDataOffset,
                size
              );
              moofSamples.push({ pts, duration: durSec, data, key });
              trunDataOffset += size;
              currentDecodeTime += duration;
            }
            if (!moofValid) break;
          }
          if (!moofValid) break;
        }
        if (!moofValid) {
          restStart = Math.min(restStart, box.start);
        } else {
          samples.push(...moofSamples);
        }
      } else if (box.type === "mdat") {
        if (box.start >= restStart) {
        } else if (box.truncated) {
          restStart = Math.min(restStart, box.start);
        }
      }
    }
    const rest = new Uint8Array(
      u8.buffer,
      u8.byteOffset + restStart,
      u8.length - restStart
    );
    return { samples, rest };
  }
  function readVint(u8, start) {
    if (start >= u8.length) return null;
    const b = u8[start];
    let length = 0;
    let mask = 128;
    while (length < 8) {
      length++;
      if (b & mask) break;
      mask >>= 1;
    }
    if (length === 8 && !(b & mask)) return null;
    if (start + length > u8.length) return null;
    let value = b & ~mask;
    let allOnes = (b & ~mask) === (1 << 8 - length) - 1;
    for (let i = 1; i < length; i++) {
      const nextByte = u8[start + i];
      value = value * 256 + nextByte;
      if (nextByte !== 255) allOnes = false;
    }
    if (allOnes && length > 1) {
      value = -1;
    } else if (length === 1 && b === 255) {
      value = -1;
    }
    if (value > Number.MAX_SAFE_INTEGER)
      throw new Error("Vint exceeds MAX_SAFE_INTEGER");
    return { value, length };
  }
  function parseElements(u8, start, end) {
    const elements = [];
    let p = start;
    while (p < end) {
      if (p >= u8.length) break;
      const idVint = readVint(u8, p);
      if (!idVint) break;
      const idBytes = u8.subarray(p, p + idVint.length);
      const idHex = Array.from(idBytes).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      p += idVint.length;
      const sizeVint = readVint(u8, p);
      if (!sizeVint) break;
      const headerSize = idVint.length + sizeVint.length;
      p += sizeVint.length;
      let size = sizeVint.value;
      if (size === -1) {
        size = end - p;
      }
      if (p + size > u8.length) {
        elements.push({
          id: idHex,
          start: p - headerSize,
          headerSize,
          size: u8.length - p,
          dataStart: p,
          end: u8.length,
          truncated: true
        });
        break;
      }
      elements.push({
        id: idHex,
        start: p - headerSize,
        headerSize,
        size,
        dataStart: p,
        end: p + size,
        truncated: false
      });
      p += size;
    }
    return elements;
  }
  var SEGMENT = "18 53 80 67";
  var CLUSTER = "1F 43 B6 75";
  function levelOne(u8) {
    const top = parseElements(u8, 0, u8.length);
    const segment = top.find((e) => e.id === SEGMENT);
    if (segment) return parseElements(u8, segment.dataStart, segment.end);
    return top;
  }
  function classifyWebm(u8) {
    const children = levelOne(u8);
    const hasInfo = children.some((e) => e.id === "15 49 A9 66");
    const hasCluster = children.some((e) => e.id === "1F 43 B6 75");
    if (hasInfo && hasCluster) return "init+media";
    if (hasInfo) return "init";
    if (hasCluster) return "media";
    return "unknown";
  }
  function findTimecodeScale(u8) {
    const elements = parseElements(u8, 0, u8.length);
    const segment = elements.find((e) => e.id === "18 53 80 67");
    if (!segment) return null;
    const children = parseElements(u8, segment.dataStart, segment.end);
    const info = children.find((e) => e.id === "15 49 A9 66");
    if (!info) return null;
    const infoChildren = parseElements(u8, info.dataStart, info.end);
    const tcScale = infoChildren.find((e) => e.id === "2A D7 B1");
    if (!tcScale) return null;
    let value = 0;
    for (let i = 0; i < tcScale.size; i++) {
      value = value * 256 + u8[tcScale.dataStart + i];
    }
    return {
      offset: tcScale.start,
      dataOffset: tcScale.dataStart,
      value,
      size: tcScale.size
    };
  }
  function encodeVint(val) {
    if (val === -1) return [1, 255, 255, 255, 255, 255, 255, 255];
    if (val < 127) return [128 | val];
    if (val < 16383) return [64 | val >> 8, val & 255];
    if (val < 2097151) return [32 | val >> 16, val >> 8 & 255, val & 255];
    if (val < 268435455)
      return [
        16 | val >> 24,
        val >> 16 & 255,
        val >> 8 & 255,
        val & 255
      ];
    let buf = [8, 0, 0, 0, 0];
    let v = val;
    for (let i = 4; i >= 1; i--) {
      buf[i] = v & 255;
      v = Math.floor(v / 256);
    }
    buf[0] |= v;
    return buf;
  }
  function rewriteTimecodeScale(u8, speed) {
    const ts = findTimecodeScale(u8);
    const original = ts ? ts.value : 1e6;
    const scaled = Math.round(original / speed);
    if (ts) {
      if (scaled >= Math.pow(2, 8 * ts.size)) {
        throw new RangeError(
          `TimecodeScale ${scaled} does not fit in ${ts.size} bytes`
        );
      }
      const data = new Uint8Array(u8);
      let v = scaled;
      for (let i = ts.size - 1; i >= 0; i--) {
        data[ts.dataOffset + i] = v & 255;
        v = Math.floor(v / 256);
      }
      return {
        data,
        original,
        scaled,
        relativeError: Math.abs(scaled - original / speed) / (original / speed)
      };
    } else {
      const elements = parseElements(u8, 0, u8.length);
      const segment = elements.find((e) => e.id === "18 53 80 67");
      const children = parseElements(u8, segment.dataStart, segment.end);
      const info = children.find((e) => e.id === "15 49 A9 66");
      const newElement = new Uint8Array([42, 215, 177, 131, 0, 0, 0]);
      let v = scaled;
      for (let i = 2; i >= 0; i--) {
        newElement[4 + i] = v & 255;
        v = Math.floor(v / 256);
      }
      const infoIdVint = readVint(u8, info.start);
      const infoSizeVint = readVint(u8, info.start + infoIdVint.length);
      const oldInfoSize = infoSizeVint.value;
      const segmentIdVint = readVint(u8, segment.start);
      const segmentSizeVint = readVint(u8, segment.start + segmentIdVint.length);
      const oldSegmentSize = segmentSizeVint.value;
      const newInfoSize = oldInfoSize === -1 ? -1 : oldInfoSize + 7;
      const newInfoSizeEncoded = encodeVint(newInfoSize);
      const infoSizeDiff = newInfoSizeEncoded.length - infoSizeVint.length;
      const newSegmentSize = oldSegmentSize === -1 ? -1 : oldSegmentSize + 7 + infoSizeDiff;
      const newSegmentSizeEncoded = encodeVint(newSegmentSize);
      const segmentSizeDiff = newSegmentSizeEncoded.length - segmentSizeVint.length;
      const totalDiff = 7 + infoSizeDiff + segmentSizeDiff;
      const data = new Uint8Array(u8.length + totalDiff);
      let dest = 0;
      const segSizeOffset = segment.start + segmentIdVint.length;
      data.set(u8.subarray(0, segSizeOffset), dest);
      dest += segSizeOffset;
      data.set(newSegmentSizeEncoded, dest);
      dest += newSegmentSizeEncoded.length;
      const infoSizeOffset = info.start + infoIdVint.length;
      data.set(
        u8.subarray(segSizeOffset + segmentSizeVint.length, infoSizeOffset),
        dest
      );
      dest += infoSizeOffset - (segSizeOffset + segmentSizeVint.length);
      data.set(newInfoSizeEncoded, dest);
      dest += newInfoSizeEncoded.length;
      data.set(newElement, dest);
      dest += newElement.length;
      const restStart = infoSizeOffset + infoSizeVint.length;
      data.set(u8.subarray(restStart), dest);
      return {
        data,
        original,
        scaled,
        relativeError: Math.abs(scaled - original / speed) / (original / speed)
      };
    }
  }
  function audioConfigFromWebmInit(u8) {
    const elements = parseElements(u8, 0, u8.length);
    const segment = elements.find((e) => e.id === "18 53 80 67");
    if (!segment) return { unsupported: true };
    const children = parseElements(u8, segment.dataStart, segment.end);
    const tracks = children.find((e) => e.id === "16 54 AE 6B");
    if (!tracks) return { unsupported: true };
    const trackEntries = parseElements(u8, tracks.dataStart, tracks.end).filter(
      (e) => e.id === "AE"
    );
    for (const track of trackEntries) {
      const tChildren = parseElements(u8, track.dataStart, track.end);
      const codecId = tChildren.find((e) => e.id === "86");
      if (codecId) {
        const codecStr = new TextDecoder().decode(
          u8.subarray(codecId.dataStart, codecId.end)
        );
        if (codecStr === "A_OPUS") {
          let channels = 2;
          let sampleRate = 48e3;
          const audio = tChildren.find((e) => e.id === "E1");
          if (audio) {
            const aChildren = parseElements(u8, audio.dataStart, audio.end);
            const ch = aChildren.find((e) => e.id === "9F");
            if (ch) {
              channels = 0;
              for (let i = 0; i < ch.size; i++)
                channels = channels * 256 + u8[ch.dataStart + i];
            }
          }
          const codecPrivate = tChildren.find((e) => e.id === "63 A2");
          if (!codecPrivate || codecPrivate.truncated)
            return { unsupported: true, codec: "opus" };
          const description = new Uint8Array(
            u8.buffer,
            u8.byteOffset + codecPrivate.dataStart,
            codecPrivate.size
          );
          const numEl = tChildren.find((e) => e.id === "D7");
          let trackNumber = 1;
          if (numEl) {
            trackNumber = 0;
            for (let i = 0; i < numEl.size; i++)
              trackNumber = trackNumber * 256 + u8[numEl.dataStart + i];
          }
          return {
            codec: "opus",
            sampleRate,
            numberOfChannels: channels,
            description,
            trackNumber
          };
        }
      }
    }
    return { unsupported: true };
  }
  function demuxClusters(u8, { timecodeScale, trackNumber }) {
    const frames = [];
    let restStart = u8.length;
    const children = levelOne(u8);
    const clusters = children.filter((e) => e.id === CLUSTER);
    const last = children[children.length - 1];
    if (last && !last.truncated && last.end < u8.length && children.every((e) => e.id !== SEGMENT)) {
      restStart = last.end;
    }
    for (const cluster of clusters) {
      if (cluster.truncated) {
        restStart = Math.min(restStart, cluster.start);
        continue;
      }
      let clusterValid = true;
      const cChildren = parseElements(u8, cluster.dataStart, cluster.end);
      const timecodeEl = cChildren.find((e) => e.id === "E7");
      let clusterTimecode = 0;
      if (timecodeEl) {
        for (let i = 0; i < timecodeEl.size; i++)
          clusterTimecode = clusterTimecode * 256 + u8[timecodeEl.dataStart + i];
      }
      for (const el of cChildren) {
        if (el.truncated) {
          clusterValid = false;
          break;
        }
        if (el.id === "A3" || el.id === "A0") {
          let blockDataStart = el.dataStart;
          let blockDataEnd = el.end;
          let isSimple = el.id === "A3";
          if (!isSimple) {
            const bgChildren = parseElements(u8, el.dataStart, el.end);
            const blockEl = bgChildren.find((e) => e.id === "A1");
            if (!blockEl) continue;
            if (blockEl.truncated) {
              clusterValid = false;
              break;
            }
            blockDataStart = blockEl.dataStart;
            blockDataEnd = blockEl.end;
          }
          let p = blockDataStart;
          const trackNumVint = readVint(u8, p);
          if (!trackNumVint) {
            clusterValid = false;
            break;
          }
          if (trackNumVint.value !== trackNumber) continue;
          p += trackNumVint.length;
          if (p + 2 > blockDataEnd) {
            clusterValid = false;
            break;
          }
          const relativeTimecode = u8[p] << 8 | u8[p + 1];
          const rtSigned = relativeTimecode >= 32768 ? relativeTimecode - 65536 : relativeTimecode;
          p += 2;
          const flags = u8[p++];
          const lacing = (flags & 6) >> 1;
          if (lacing !== 0) {
            const err = new Error("Lacing not supported");
            err.name = "NotSupportedError";
            throw err;
          }
          const key = isSimple ? (flags & 128) !== 0 : true;
          const pts = (clusterTimecode + rtSigned) * timecodeScale / 1e9;
          const data = new Uint8Array(
            u8.buffer,
            u8.byteOffset + p,
            blockDataEnd - p
          );
          frames.push({ pts, data, key, start: el.start });
        }
      }
      if (!clusterValid) {
        restStart = Math.min(restStart, cluster.start);
      }
    }
    const validFrames = frames.filter((f) => f.start < restStart).map((f) => ({ pts: f.pts, data: f.data, key: f.key }));
    const rest = new Uint8Array(
      u8.buffer,
      u8.byteOffset + restStart,
      u8.length - restStart
    );
    return { frames: validFrames, rest };
  }

  // v2b/src/mse-hook.js
  var SUPPORTED_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  function isSupportedSpeed(speed) {
    return SUPPORTED_SPEEDS.includes(speed);
  }
  function isMuxedAudioVideo(mime) {
    if (!/^\s*video\//i.test(mime)) return false;
    const m = /codecs\s*=\s*"?([^";]*)/i.exec(mime);
    if (!m) return false;
    return m[1].split(",").some((c) => /^(mp4a|opus|ac-3|ec-3|ac-4|flac|vorbis|mp3|dts)/i.test(c.trim()));
  }
  function domError(name, message) {
    const err = new Error(message || name);
    err.name = name;
    return err;
  }
  function sameAudioConfig(a, b) {
    if (!a || !b) return false;
    if (a.codec !== b.codec || a.sampleRate !== b.sampleRate || a.numberOfChannels !== b.numberOfChannels)
      return false;
    const da = a.description ? new Uint8Array(a.description) : null;
    const db = b.description ? new Uint8Array(b.description) : null;
    if (!da || !db) return da === db;
    if (da.length !== db.length) return false;
    for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
    return true;
  }
  var SpeedTimeMap = class {
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
      const mapFn = direction === "toContent" ? (t) => this.toContent(t) : (t) => this.toElement(t);
      return {
        length: ranges.length,
        start(i) {
          if (i < 0 || i >= this.length)
            throw new RangeError("Index out of bounds");
          return mapFn(ranges.start(i));
        },
        end(i) {
          if (i < 0 || i >= this.length)
            throw new RangeError("Index out of bounds");
          return mapFn(ranges.end(i));
        }
      };
    }
  };
  function attachElementShim(el, timeMap, { onRateRequest }) {
    if (timeMap.speed === 1) return { detach: () => {
    }, isAttached: () => false };
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
          get: get ? function() {
            return get.call(this, desc.get);
          } : function() {
            return desc.get.call(this);
          }
        };
        if (set) {
          newDesc.set = function(val) {
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
      "currentTime",
      function(origGet) {
        return timeMap.toContent(origGet.call(this));
      },
      function(val, origSet) {
        origSet.call(this, timeMap.toElement(val));
      }
    );
    defineProp("duration", function(origGet) {
      const d = origGet.call(this);
      return isNaN(d) ? d : timeMap.toContent(d);
    });
    defineProp("buffered", function(origGet) {
      return mapRanges(origGet.call(this));
    });
    defineProp("seekable", function(origGet) {
      return mapRanges(origGet.call(this));
    });
    defineProp(
      "playbackRate",
      function() {
        return timeMap.speed;
      },
      function(val, _origSet) {
        if (onRateRequest) onRateRequest(val);
      }
    );
    const initialSrc = el.src;
    defineProp("src", null, function(val, origSet) {
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
        delete el[prop];
      }
    }
    return { detach, isAttached: () => !detached };
  }
  function installMseHook(win, { getSpeed, createAudioSink, onRateRequest, onError, onNativeAudio }) {
    const origAddSourceBuffer = win.MediaSource.prototype.addSourceBuffer;
    const origRemoveSourceBuffer = win.MediaSource.prototype.removeSourceBuffer;
    const origCreateObjectURL = win.URL.createObjectURL;
    const origRevokeObjectURL = win.URL.revokeObjectURL;
    const origSrcDesc = Object.getOwnPropertyDescriptor(
      win.HTMLMediaElement.prototype,
      "src"
    );
    const sessions = /* @__PURE__ */ new WeakMap();
    const urlToMs = /* @__PURE__ */ new Map();
    const msToEl = /* @__PURE__ */ new WeakMap();
    const elToShim = /* @__PURE__ */ new WeakMap();
    const decided = /* @__PURE__ */ new WeakMap();
    const stats = { sessions: 0, durationRebased: 0, rebaseErrors: 0, lastRebase: null };
    // 1.3.8: urlToMs only bridges createObjectURL -> media.src; it pinned every MediaSource of the page for good (+2 closed
    // MediaSource per v2b engage + respeed, tests/app/leak.mjs). The entry goes on revokeObjectURL (hls.js revokes on
    // detach); MAX_URLS bounds it for players that never revoke.
    const MAX_URLS = 8;
    Object.defineProperty(stats, "urlMap", { enumerable: true, get: () => urlToMs.size });
    function attach(el, session) {
      const cur = elToShim.get(el);
      if (cur && cur.session === session && cur.shim.isAttached()) return;
      if (cur && cur.shim.isAttached()) cur.shim.detach();
      const shim = attachElementShim(el, session.timeMap, { onRateRequest });
      elToShim.set(el, { shim, session });
    }
    win.URL.createObjectURL = function(obj) {
      const url = origCreateObjectURL.call(this, obj);
      if (obj instanceof win.MediaSource) {
        urlToMs.set(url, obj);
        while (urlToMs.size > MAX_URLS) urlToMs.delete(urlToMs.keys().next().value);
      }
      return url;
    };
    win.URL.revokeObjectURL = function(url) {
      urlToMs.delete(url);
      return origRevokeObjectURL.call(this, url);
    };
    if (origSrcDesc) {
      Object.defineProperty(win.HTMLMediaElement.prototype, "src", {
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
    win.MediaSource.prototype.addSourceBuffer = function(mime) {
      if (!decided.has(this)) {
        let speed2 = getSpeed();
        if (speed2 !== 1 && isMuxedAudioVideo(mime)) {
          speed2 = 1;
          if (onError) onError(new Error(`muxed audio/video SourceBuffer: ${mime}`));
        }
        decided.set(this, speed2);
        if (decided.get(this) === 1 && onNativeAudio) onNativeAudio();
      }
      const speed = decided.get(this);
      if (speed === 1) {
        return origAddSourceBuffer.call(this, mime);
      }
      const isVideo = mime.startsWith("video/");
      const isAudio = mime.startsWith("audio/");
      let session = sessions.get(this);
      if (!session) {
        session = {
          speed,
          audio: null,
          video: null,
          timeMap: new SpeedTimeMap(speed)
        };
        sessions.set(this, session);
        stats.sessions++;
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
    win.MediaSource.prototype.removeSourceBuffer = function(sb) {
      if (sb instanceof FakeAudioSourceBuffer) {
        const session = sessions.get(this);
        if (!session || session.audio !== sb) {
          throw domError("NotFoundError", "SourceBuffer is not in this MediaSource");
        }
        session.audio = null;
        sb._detach();
        return void 0;
      }
      return origRemoveSourceBuffer.call(this, sb);
    };
    function patchMediaSource(ms, session) {
      let origDurationDesc = Object.getOwnPropertyDescriptor(ms, "duration");
      if (!origDurationDesc) {
        origDurationDesc = Object.getOwnPropertyDescriptor(
          win.MediaSource.prototype,
          "duration"
        );
      }
      if (origDurationDesc) {
        // 1.3.2: players set MediaSource.duration (content time) before the first addSourceBuffer() - hls.js on
        // 'sourceopen' and on LEVEL_UPDATED while it has no SourceBuffer yet. That was before this session existed, so
        // the value reached the native setter unscaled; the getter below then reported S x content, and hls.js only ever
        // grows the duration, so it never corrected it: element.duration (shim) = S x the VOD length until endOfStream().
        // Rebase it now. No native SourceBuffer exists yet (the session starts at the first addSourceBuffer), so the
        // setter is allowed and nothing is buffered beyond the new end.
        try {
          const d0 = origDurationDesc.get.call(ms);
          if (typeof d0 === "number" && isFinite(d0) && d0 > 0 && ms.readyState === "open") {
            origDurationDesc.set.call(ms, d0 / session.speed);
            stats.durationRebased++;
            stats.lastRebase = { from: d0, to: d0 / session.speed, speed: session.speed };
          }
        } catch (e) {
          stats.rebaseErrors++;
          if (onError) onError(new Error("duration rebase failed: " + (e && e.message || e)));
        }
        Object.defineProperty(ms, "duration", {
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
        "sourceBuffers"
      );
      if (!origSourceBuffersDesc) {
        origSourceBuffersDesc = Object.getOwnPropertyDescriptor(
          win.MediaSource.prototype,
          "sourceBuffers"
        );
      }
      if (origSourceBuffersDesc) {
        Object.defineProperty(ms, "sourceBuffers", {
          get() {
            const realSbList = origSourceBuffersDesc.get.call(this);
            const list = {
              length: realSbList.length + (session.audio ? 1 : 0),
              item(idx) {
                if (idx < realSbList.length) return realSbList.item(idx);
                if (idx === realSbList.length && session.audio)
                  return session.audio;
                return void 0;
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
      if (u8.length >= 4 && u8[0] === 26 && u8[1] === 69 && u8[2] === 223 && u8[3] === 163)
        return true;
      if (u8.length >= 8) {
        const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
        return t === "ftyp" || t === "moov";
      }
      return false;
    }
    function patchVideoSourceBuffer(sb, mime, speed, onError2) {
      const origAppendBuffer = sb.appendBuffer;
      const origRemove = sb.remove;
      const isMp4 = mime.includes("mp4");
      const isWebm = mime.includes("webm");
      sb.appendBuffer = function(data) {
        let toAppend = data;
        let problem = null;
        try {
          const u8 = new Uint8Array(data);
          let isInit = false;
          if (isMp4) {
            const type = classifyMp4(u8);
            if (type === "init" || type === "init+media") isInit = true;
          } else if (isWebm) {
            const type = classifyWebm(u8);
            if (type === "init" || type === "init+media") isInit = true;
          }
          if (isInit) {
            if (isMp4) {
              toAppend = rewriteInitTimescale(u8, speed).data;
              if (trackHandlers(u8).includes("soun")) {
                problem = new Error("audio track inside the video SourceBuffer");
              }
            } else if (isWebm) {
              toAppend = rewriteTimecodeScale(new Uint8Array(u8), speed).data;
            }
          } else if (looksLikeInitStart(u8)) {
            problem = new Error("init segment split across appends");
          }
        } catch (e) {
          problem = e;
          toAppend = data;
        }
        if (problem && onError2) onError2(problem);
        return origAppendBuffer.call(this, toAppend);
      };
      sb.remove = function(start, end) {
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
      defineAccessor("timestampOffset", speed);
      defineAccessor("appendWindowStart", speed);
      defineAccessor("appendWindowEnd", speed);
      let descBuf = Object.getOwnPropertyDescriptor(sb, "buffered");
      let protoBuf = sb;
      while (!descBuf && protoBuf) {
        protoBuf = Object.getPrototypeOf(protoBuf);
        descBuf = Object.getOwnPropertyDescriptor(protoBuf, "buffered");
      }
      if (descBuf) {
        Object.defineProperty(sb, "buffered", {
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
      win.URL.revokeObjectURL = origRevokeObjectURL;
      urlToMs.clear();
      if (origSrcDesc) {
        Object.defineProperty(win.HTMLMediaElement.prototype, "src", origSrcDesc);
      }
    }
    const MAX_REST = 4 * 1024 * 1024;
    class FakeAudioSourceBuffer extends win.EventTarget {
      constructor(win2, mime, speed, sink, onError2) {
        super();
        this.win = win2;
        this.mime = mime;
        this.speed = speed;
        this.sink = sink;
        this.onError = onError2;
        this.isMp4 = mime.includes("mp4");
        this.isWebm = mime.includes("webm");
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
              throw new RangeError("Index out of bounds");
            return this.bufferedRanges[i].start;
          },
          end: (i) => {
            if (i < 0 || i >= this.bufferedRanges.length)
              throw new RangeError("Index out of bounds");
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
            if (r.start <= last.end + 1e-3) {
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
          throw domError("InvalidStateError", "SourceBuffer has been removed");
        }
        if (this.updating) {
          const err = new Error("InvalidStateError");
          err.name = "InvalidStateError";
          throw err;
        }
        this.updating = true;
        this.dispatchEvent(new win.Event("updatestart"));
        const chunk = new Uint8Array(data);
        const u8 = new Uint8Array(this.rest.length + chunk.length);
        u8.set(this.rest, 0);
        u8.set(chunk, this.rest.length);
        try {
          if (this.isMp4) {
            const type = classifyMp4(u8);
            const moov = parseBoxes(u8, 0, u8.length).find(
              (b) => b.type === "moov"
            );
            if (moov && moov.truncated) {
              this.rest = u8;
            } else if (type === "init" || type === "init+media") {
              const cfg = audioConfigFromInit(u8);
              if (cfg.unsupported) {
                const err = new Error("Unsupported audio");
                err.name = "NotSupportedError";
                throw err;
              }
              this._configure(cfg);
              this.initInfo = parseInitInfo(u8);
              if (type === "init+media") {
                const res = demuxFragments(u8, this.initInfo);
                this.rest = res.rest;
                if (res.samples.length > 0) {
                  const adjusted = res.samples.map((s) => Object.assign({}, s, {
                    pts: s.pts + this._timestampOffset
                  }));
                  this.sink.push(adjusted);
                  const start = adjusted[0].pts;
                  const end = adjusted[adjusted.length - 1].pts + adjusted[adjusted.length - 1].duration;
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
            } else if (type === "media" && this.initInfo) {
              const res = demuxFragments(u8, this.initInfo);
              this.rest = res.rest;
              if (res.samples.length > 0) {
                const adjusted = res.samples.map((s) => Object.assign({}, s, {
                  pts: s.pts + this._timestampOffset
                }));
                this.sink.push(adjusted);
                const start = adjusted[0].pts;
                const end = adjusted[adjusted.length - 1].pts + adjusted[adjusted.length - 1].duration;
                this._addRange(start, end);
              }
            } else {
              this.rest = u8;
            }
          } else if (this.isWebm) {
            const type = classifyWebm(u8);
            if (type === "init" || type === "init+media") {
              const cfg = audioConfigFromWebmInit(u8);
              if (cfg.unsupported) {
                const err = new Error("Unsupported audio");
                err.name = "NotSupportedError";
                throw err;
              }
              this._configure(cfg);
              const tcScaleObj = findTimecodeScale(u8);
              this.initInfo = {
                timecodeScale: tcScaleObj ? tcScaleObj.value : 1e6,
                trackNumber: cfg.trackNumber
              };
              if (type === "init+media") {
                const res = demuxClusters(u8, this.initInfo);
                this.rest = res.rest;
                if (res.frames && res.frames.length > 0) {
                  for (let i = 0; i < res.frames.length; i++) {
                    if (i < res.frames.length - 1) {
                      res.frames[i].duration = res.frames[i + 1].pts - res.frames[i].pts;
                    } else {
                      res.frames[i].duration = i > 0 && res.frames[i - 1].duration > 0 ? res.frames[i - 1].duration : 0.02;
                    }
                  }
                  const adjusted = res.frames.map((f) => Object.assign({}, f, {
                    pts: f.pts + this._timestampOffset
                  }));
                  this.sink.push(adjusted);
                  const start = adjusted[0].pts;
                  const end = adjusted[adjusted.length - 1].pts + adjusted[adjusted.length - 1].duration;
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
            } else if (type === "media" && this.initInfo) {
              const res = demuxClusters(u8, this.initInfo);
              this.rest = res.rest;
              if (res.frames && res.frames.length > 0) {
                for (let i = 0; i < res.frames.length; i++) {
                  if (i < res.frames.length - 1) {
                    res.frames[i].duration = res.frames[i + 1].pts - res.frames[i].pts;
                  } else {
                    res.frames[i].duration = i > 0 && res.frames[i - 1].duration > 0 ? res.frames[i - 1].duration : 0.02;
                  }
                }
                const adjusted = res.frames.map((f) => Object.assign({}, f, {
                  pts: f.pts + this._timestampOffset
                }));
                this.sink.push(adjusted);
                const start = adjusted[0].pts;
                const end = adjusted[adjusted.length - 1].pts + adjusted[adjusted.length - 1].duration;
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
          this.rest = new Uint8Array(0);
          if (this.onError) this.onError(new Error("unparsable audio data"));
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
        const gen = ++this._gen;
        Promise.resolve().then(() => {
          if (gen !== this._gen || !this.updating) return;
          this.dispatchEvent(new win.Event("update"));
          this.updating = false;
          const e = new win.Event("updateend");
          this.dispatchEvent(e);
          if (this.onupdateend) this.onupdateend(e);
        });
      }
      remove(start, end) {
        if (this.removed) {
          throw domError("InvalidStateError", "SourceBuffer has been removed");
        }
        if (this.updating) {
          const err = new Error("InvalidStateError");
          err.name = "InvalidStateError";
          throw err;
        }
        this.updating = true;
        this.dispatchEvent(new win.Event("updatestart"));
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
          const eAbort = new win.Event("abort");
          this.dispatchEvent(eAbort);
          if (this.onabort) this.onabort(eAbort);
          const eUpdateEnd = new win.Event("updateend");
          this.dispatchEvent(eUpdateEnd);
          if (this.onupdateend) this.onupdateend(eUpdateEnd);
        }
      }
      changeType(type) {
        if (this.removed || this.updating) {
          throw domError("InvalidStateError", "changeType() not allowed now");
        }
        if (typeof type !== "string" || type === "") {
          throw new TypeError("changeType() needs a MIME type");
        }
        const wasMp4 = this.isMp4;
        this.mime = type;
        this.isMp4 = type.includes("mp4");
        this.isWebm = type.includes("webm");
        this.rest = new Uint8Array(0);
        if (this.isMp4 !== wasMp4) this.initInfo = null;
      }
      // MediaSource.removeSourceBuffer(): stop the engine of this buffer.
      _detach() {
        this.abort();
        this.removed = true;
        this.bufferedRanges = [];
        this.rest = new Uint8Array(0);
        if (typeof this.sink.destroy === "function") this.sink.destroy();
        else this.sink.reset();
      }
    }
    return { uninstall, stats };
  }

  // v2b/src/entry.js
  window.STTVMseHook = {
    version: "1.3.8",
    installMseHook,
    SUPPORTED_SPEEDS,
    isSupportedSpeed,
    SpeedTimeMap,
    _containers: { rewriteInitTimescale, classifyMp4, findMdhdTimescale }
  };
})();
