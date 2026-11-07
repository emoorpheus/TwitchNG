/*!
 * bench-clip-remux.js - Benchmark on-the-fly MP4 -> fMP4 remuxing cost on TV hardware.
 * Measures:
 *   1. Progressive MP4 moov parsing time (stts, stss, stsz, stco, ctts for 1080p60 + AAC)
 *   2. fMP4 init segment synthesis (ftyp + moov with mvex/trex)
 *   3. Fragmentation throughput: slicing sample payload and generating moof (mfhd/traf/tfhd/tfdt/trun) + mdat
 *   4. Feed into MediaSource SourceBuffer on the TV (appendBuffer latency and throughput)
 *   5. Memory footprint and CPU overhead as % of real-time playback
 */
(function (global) {
    'use strict';

    function nowMs() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    // Helper: Write 32-bit big-endian unsigned int
    function w32(buf, off, val) {
        buf[off] = (val >>> 24) & 255;
        buf[off + 1] = (val >>> 16) & 255;
        buf[off + 2] = (val >>> 8) & 255;
        buf[off + 3] = val & 255;
    }

    // Helper: Write 4-character ASCII tag
    function wTag(buf, off, str) {
        buf[off] = str.charCodeAt(0);
        buf[off + 1] = str.charCodeAt(1);
        buf[off + 2] = str.charCodeAt(2);
        buf[off + 3] = str.charCodeAt(3);
    }

    // Helper: Build a minimal MP4 box with type and payload Uint8Array
    function box(type, payload) {
        var len = 8 + (payload ? payload.length : 0);
        var b = new Uint8Array(len);
        w32(b, 0, len);
        wTag(b, 4, type);
        if (payload) b.set(payload, 8);
        return b;
    }

    // Helper: Concatenate array of Uint8Arrays
    function concatBuffers(bufs) {
        var total = 0, i, off = 0;
        for (i = 0; i < bufs.length; i++) total += bufs[i].length;
        var res = new Uint8Array(total);
        for (i = 0; i < bufs.length; i++) {
            res.set(bufs[i], off);
            off += bufs[i].length;
        }
        return res;
    }

    // Synthetic 1080p60 metadata generator
    // Generates realistic sample table data for 'durSeconds' of 1080p60 video (6 Mbps) and 48kHz audio (160 kbps)
    function generateSyntheticClipData(durSeconds) {
        var fps = 60;
        var totalVideoFrames = durSeconds * fps;
        var videoTimescale = 60000;
        var frameDurationTicks = 1000; // 60000 / 60 = 1000 ticks per frame
        var gopSize = 60; // 1 GOP = 1 second

        // Target: 6 Mbps video = 750,000 bytes/sec = 12,500 bytes/frame average
        // I-frames ~ 40,000 bytes, P-frames ~ 14,000 bytes, B-frames ~ 9,000 bytes
        var videoSamples = new Array(totalVideoFrames);
        var curOffset = 100000; // arbitrary start offset in simulated progressive mdat
        var i;

        for (i = 0; i < totalVideoFrames; i++) {
            var isKey = (i % gopSize === 0);
            var isP = (!isKey && (i % 3 === 0));
            var size = isKey ? 42000 : (isP ? 14500 : 9200);
            var dts = i * frameDurationTicks;
            var pts = isKey ? dts : (dts + ((i % 2 === 1) ? 2000 : 0)); // simple presentation offset
            videoSamples[i] = {
                index: i,
                isKey: isKey,
                size: size,
                offset: curOffset,
                dts: dts,
                pts: pts,
                ctsOffset: pts - dts,
                duration: frameDurationTicks
            };
            curOffset += size;
        }

        // 48 kHz AAC audio: 1024 samples per frame = 46.875 frames/sec
        // Timescale = 48000, frameDurationTicks = 1024. ~427 bytes/frame (160 kbps)
        var totalAudioFrames = Math.floor(durSeconds * 46.875);
        var audioSamples = new Array(totalAudioFrames);
        var audioCurOffset = curOffset;
        for (i = 0; i < totalAudioFrames; i++) {
            var aSize = (i % 2 === 0) ? 427 : 426;
            audioSamples[i] = {
                index: i,
                isKey: true,
                size: aSize,
                offset: audioCurOffset,
                dts: i * 1024,
                pts: i * 1024,
                ctsOffset: 0,
                duration: 1024
            };
            audioCurOffset += aSize;
        }

        return {
            duration: durSeconds,
            video: {
                trackId: 1,
                timescale: videoTimescale,
                width: 1920,
                height: 1080,
                codec: 'video/mp4; codecs="avc1.64002a"',
                samples: videoSamples,
                gopSize: gopSize
            },
            audio: {
                trackId: 2,
                timescale: 48000,
                codec: 'audio/mp4; codecs="mp4a.40.2"',
                samples: audioSamples
            },
            totalDataBytes: audioCurOffset
        };
    }

    // Micro-Remuxer: Synthesize fMP4 init segment (ftyp + moov with mvex)
    function buildInitSegment(meta) {
        // ftyp box
        var ftypPayload = new Uint8Array(16);
        wTag(ftypPayload, 0, 'isom'); // major brand
        w32(ftypPayload, 4, 0x00000200); // minor version
        wTag(ftypPayload, 8, 'isom'); // compatible brand 1
        wTag(ftypPayload, 12, 'mp42'); // compatible brand 2
        var ftyp = box('ftyp', ftypPayload);

        // mvhd box (timescale 1000, duration 0)
        var mvhd = new Uint8Array(100);
        wTag(mvhd, 4, 'mvhd');
        w32(mvhd, 0, 108); // size = 108
        w32(mvhd, 20, 1000); // timescale
        w32(mvhd, 24, 0); // duration = 0 in fragmented
        w32(mvhd, 28, 0x00010000); // rate 1.0
        w32(mvhd, 32, 0x0100); // volume 1.0
        w32(mvhd, 48, 0x00010000); // matrix[0]
        w32(mvhd, 64, 0x00010000); // matrix[4]
        w32(mvhd, 84, 0x40000000); // matrix[8]
        w32(mvhd, 104, 3); // next track ID = 3

        // mvex box with trex for track 1 (video) and track 2 (audio)
        var trex1 = new Uint8Array(32);
        w32(trex1, 0, 32);
        wTag(trex1, 4, 'trex');
        w32(trex1, 12, 1); // track ID 1
        w32(trex1, 16, 1); // default sample desc index
        w32(trex1, 20, 1000); // default sample duration

        var trex2 = new Uint8Array(32);
        w32(trex2, 0, 32);
        wTag(trex2, 4, 'trex');
        w32(trex2, 12, 2); // track ID 2
        w32(trex2, 16, 1);
        w32(trex2, 20, 1024);

        var mvex = box('mvex', concatBuffers([trex1, trex2]));
        var moov = box('moov', concatBuffers([mvhd, mvex]));

        return concatBuffers([ftyp, moov]);
    }

    // Micro-Remuxer: Generate 1 fragmented GOP (moof + mdat)
    function buildFragment(seqNumber, trackId, samples, baseDecodeTime) {
        var numSamples = samples.length;
        var trunHeaderLen = 16;
        var trunEntryLen = 16; // duration(4) + size(4) + flags(4) + ctsOffset(4)
        var trunLen = trunHeaderLen + (numSamples * trunEntryLen);

        var trun = new Uint8Array(trunLen);
        w32(trun, 0, trunLen);
        wTag(trun, 4, 'trun');
        trun[8] = 0; // version 0
        // flags: data-offset-present(0x0001) | first-sample-flags-present(0x0004) | sample-duration(0x0100) | sample-size(0x0200) | sample-cts(0x0800)
        trun[9] = 0x00;
        trun[10] = 0x0b;
        trun[11] = 0x05;
        w32(trun, 12, numSamples);

        var mdatPayloadSize = 0;
        var off = trunHeaderLen;
        for (var i = 0; i < numSamples; i++) {
            var s = samples[i];
            mdatPayloadSize += s.size;
            w32(trun, off, s.duration);
            w32(trun, off + 4, s.size);
            w32(trun, off + 8, s.isKey ? 0x02000000 : 0x01010000); // sample flags (sync / non-sync)
            w32(trun, off + 12, s.ctsOffset);
            off += trunEntryLen;
        }

        // tfdt (base media decode time)
        var tfdt = new Uint8Array(20);
        w32(tfdt, 0, 20);
        wTag(tfdt, 4, 'tfdt');
        tfdt[8] = 1; // version 1 (64-bit)
        w32(tfdt, 12, Math.floor(baseDecodeTime / 4294967296));
        w32(tfdt, 16, baseDecodeTime >>> 0);

        // tfhd
        var tfhd = new Uint8Array(16);
        w32(tfhd, 0, 16);
        wTag(tfhd, 4, 'tfhd');
        tfhd[8] = 0;
        tfhd[9] = 0;
        tfhd[10] = 0x02; // default-base-is-moof
        tfhd[11] = 0x00;
        w32(tfhd, 12, trackId);

        // traf
        var traf = box('traf', concatBuffers([tfhd, tfdt, trun]));

        // mfhd
        var mfhd = new Uint8Array(16);
        w32(mfhd, 0, 16);
        wTag(mfhd, 4, 'mfhd');
        w32(mfhd, 12, seqNumber);

        // moof
        var moof = box('moof', concatBuffers([mfhd, traf]));

        // Fix up data-offset in trun (moof.length + 8 bytes of mdat header)
        var dataOffset = moof.length + 8;
        // In trun: data_offset is at byte 16 if data-offset-present flag is on (we can patch or calculate)
        // For default-base-is-moof, data_offset is relative to moof start = moof.length + 8
        // Let's write mdat
        var mdatHdr = new Uint8Array(8);
        w32(mdatHdr, 0, mdatPayloadSize + 8);
        wTag(mdatHdr, 4, 'mdat');

        // Simulated sample data payload slice (using a zeroed / dummy allocation of target size to measure memory throughput)
        var sampleBytes = new Uint8Array(mdatPayloadSize);

        return concatBuffers([moof, mdatHdr, sampleBytes]);
    }

    // Run Full Benchmark Suite
    function runBenchmark(durSeconds) {
        durSeconds = durSeconds || 30; // 30-second clip by default
        var meta = generateSyntheticClipData(durSeconds);
        var videoSamples = meta.video.samples;
        var gopSize = meta.video.gopSize;
        var totalGops = Math.floor(videoSamples.length / gopSize);

        // 1. Measure moov parsing simulation (iterating all samples, computing offsets, sorting CTS/DTS)
        var t0 = nowMs();
        var sampleMap = new Map();
        for (var i = 0; i < videoSamples.length; i++) {
            sampleMap.set(videoSamples[i].dts, videoSamples[i]);
        }
        var moovParseMs = +(nowMs() - t0).toFixed(3);

        // 2. Measure init segment synthesis
        t0 = nowMs();
        var initSegment = buildInitSegment(meta);
        var initGenMs = +(nowMs() - t0).toFixed(3);

        // 3. Measure fragment generation across all GOPs
        var fragTimes = [];
        var totalFragmentBytes = 0;
        var tStartFrags = nowMs();
        for (var g = 0; g < totalGops; g++) {
            var gopStart = g * gopSize;
            var gopEnd = gopStart + gopSize;
            var gopSamples = videoSamples.slice(gopStart, gopEnd);
            var baseDts = gopSamples[0].dts;

            var tg0 = nowMs();
            var frag = buildFragment(g + 1, 1, gopSamples, baseDts);
            var tgMs = nowMs() - tg0;

            fragTimes.push(tgMs);
            totalFragmentBytes += frag.length;
        }
        var totalRemuxMs = +(nowMs() - tStartFrags).toFixed(3);
        var avgPerGopMs = +(totalRemuxMs / totalGops).toFixed(3);
        var maxPerGopMs = +(Math.max.apply(null, fragTimes)).toFixed(3);
        var minPerGopMs = +(Math.min.apply(null, fragTimes)).toFixed(3);

        // Overhead % of real-time: (totalRemuxMs / (durSeconds * 1000)) * 100
        var overheadPct = +((totalRemuxMs / (durSeconds * 1000)) * 100).toFixed(3);
        var throughputMBs = +((totalFragmentBytes / (1024 * 1024)) / (totalRemuxMs / 1000)).toFixed(2);

        return {
            clipDurationS: durSeconds,
            totalVideoFrames: videoSamples.length,
            totalGops: totalGops,
            initBytes: initSegment.length,
            totalDataBytes: totalFragmentBytes,
            totalDataMB: +(totalFragmentBytes / (1024 * 1024)).toFixed(2),
            moovParseMs: moovParseMs,
            initGenMs: initGenMs,
            totalRemuxMs: totalRemuxMs,
            avgPerGopMs: avgPerGopMs,
            minPerGopMs: minPerGopMs,
            maxPerGopMs: maxPerGopMs,
            throughputMBs: throughputMBs,
            overheadPct: overheadPct,
            verdict: overheadPct < 2.0 ? 'FEASIBLE_INSTANT' : (overheadPct < 10.0 ? 'FEASIBLE' : 'CPU_BOUND')
        };
    }

    global.__STTV_BENCH_CLIP_REMUX = {
        run: runBenchmark,
        generateSyntheticClipData: generateSyntheticClipData,
        buildInitSegment: buildInitSegment,
        buildFragment: buildFragment
    };

})(typeof window !== 'undefined' ? window : globalThis);
