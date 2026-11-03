import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportArgv,
  buildFilterGraph,
  EXPORT_MIX,
  extractProgress,
  ffmpegBinaryName,
  parseProbeOutput,
  parseWavDuration,
  resolveFfmpegPath,
  sanitizeExportBasename,
  toStartMs,
  withMp4Extension,
} from '../src/export-media.mjs';

function wavBytes({ sampleRate = 24000, channels = 1, seconds = 2, extraChunks = [] } = {}) {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = Math.floor(byteRate * seconds);
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.write('WAVE', 8);
  parts.push(header);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(16, 22);
  parts.push(fmt);
  for (const [id, size] of extraChunks) {
    const chunk = Buffer.alloc(8 + size + (size % 2));
    chunk.write(id, 0);
    chunk.writeUInt32LE(size, 4);
    parts.push(chunk);
  }
  const data = Buffer.alloc(8 + dataSize);
  data.write('data', 0);
  data.writeUInt32LE(dataSize, 4);
  parts.push(data);
  const file = Buffer.concat(parts);
  file.writeUInt32LE(file.length - 8, 4);
  return file;
}

test('resolveFfmpegPath maps dev and packaged layouts, override first', () => {
  const existsSync = (candidate) => candidate === '/dev/electron/node_modules/ffmpeg-static/ffmpeg';
  assert.equal(
    resolveFfmpegPath({ appPath: '/dev/electron', isPackaged: false, existsSync }),
    '/dev/electron/node_modules/ffmpeg-static/ffmpeg',
  );
  assert.equal(
    resolveFfmpegPath({ appPath: '/empty', isPackaged: false, existsSync }),
    null,
  );
  const packagedExists = (candidate) => candidate === '/app/resources/ffmpeg';
  assert.equal(
    resolveFfmpegPath({ resourcesPath: '/app/resources', isPackaged: true, existsSync: packagedExists }),
    '/app/resources/ffmpeg',
  );
  assert.equal(
    resolveFfmpegPath({ resourcesPath: '/bare', isPackaged: true, existsSync: packagedExists }),
    null,
  );
  assert.equal(
    resolveFfmpegPath({ env: { FFMPEG_BIN: '/custom/ffmpeg' }, appPath: '/dev/electron', existsSync }),
    '/custom/ffmpeg',
  );
  assert.equal(resolveFfmpegPath({}), null);
});

test('ffmpegBinaryName honors the Windows executable', () => {
  assert.equal(ffmpegBinaryName('win32'), 'ffmpeg.exe');
  assert.equal(ffmpegBinaryName('darwin'), 'ffmpeg');
  assert.equal(ffmpegBinaryName('linux'), 'ffmpeg');
});

test('parseWavDuration reads any PCM layout and skips extra chunks', () => {
  assert.equal(parseWavDuration(wavBytes({ sampleRate: 24000, channels: 1, seconds: 2 })), 2);
  assert.equal(parseWavDuration(wavBytes({ sampleRate: 48000, channels: 2, seconds: 1.5 })), 1.5);
  assert.equal(
    parseWavDuration(wavBytes({ seconds: 1, extraChunks: [['JUNK', 10], ['bext', 7]] })),
    1,
  );
});

test('parseWavDuration rejects malformed files with safe errors', () => {
  assert.throws(() => parseWavDuration(Buffer.alloc(10)), /too short/);
  assert.throws(() => parseWavDuration(Buffer.alloc(64, 7)), /RIFF\/WAVE/);
  const noData = wavBytes({ seconds: 1 }).subarray(0, 36);
  assert.throws(() => parseWavDuration(noData), /too short|data chunk/);
  const badRate = wavBytes({ seconds: 1 });
  badRate.writeUInt32LE(0, 28);
  assert.throws(() => parseWavDuration(badRate), /invalid audio parameters/);
});

const PROBE_FIXTURE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'src.mp4':
  Duration: 00:00:06.00, start: 0.000000, bitrate: 369 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp
At least one output file must be specified
`;

test('parseProbeOutput inventories streams and duration', () => {
  assert.deepEqual(parseProbeOutput(PROBE_FIXTURE), {
    duration: 6,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
  });
  const silent = PROBE_FIXTURE.split('\n')
    .filter((line) => !line.includes('Audio:'))
    .join('\n');
  const parsed = parseProbeOutput(silent);
  assert.equal(parsed.hasAudio, false);
  assert.equal(parsed.hasVideo, true);
  assert.equal(parsed.duration, 6);
  assert.deepEqual(parseProbeOutput('garbage\nnope\n'), {
    duration: null,
    hasVideo: false,
    hasAudio: false,
    videoCodec: null,
  });
});

test('extractProgress reads microseconds and the end sentinel', () => {
  assert.deepEqual(extractProgress('out_time_us=5933333\nprogress=continue\n'), {
    timeUs: 5933333,
    ended: false,
  });
  // out_time_ms is microseconds despite its name (verified ffmpeg 7.0).
  assert.deepEqual(extractProgress('out_time_ms=1500000\n'), { timeUs: 1500000, ended: false });
  assert.deepEqual(extractProgress('out_time=00:00:03.500000\n'), {
    timeUs: 3500000,
    ended: false,
  });
  assert.deepEqual(extractProgress('progress=end\n'), { timeUs: null, ended: true });
  assert.deepEqual(extractProgress(''), { timeUs: null, ended: false });
  assert.deepEqual(extractProgress('bitrate= 100kbits/s\n'), { timeUs: null, ended: false });
});

test('toStartMs converts evidence timestamps to absolute offsets', () => {
  assert.equal(toStartMs(0), 0);
  assert.equal(toStartMs(2.5), 2500);
  assert.equal(toStartMs(2.5004), 2500);
  assert.throws(() => toStartMs(-1), /non-negative/);
  assert.throws(() => toStartMs(Number.NaN), /non-negative/);
  assert.throws(() => toStartMs('3'), /non-negative/);
});

test('sanitizeExportBasename strips unsafe characters with a fallback', () => {
  assert.equal(sanitizeExportBasename('Free Fire Finals'), 'Free Fire Finals');
  assert.equal(sanitizeExportBasename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeExportBasename('   '), 'commentary-export');
  assert.equal(sanitizeExportBasename('trailing...   '), 'trailing');
  assert.equal(sanitizeExportBasename(null), 'commentary-export');
  assert.equal(sanitizeExportBasename('x'.repeat(200)).length, 100);
});

test('withMp4Extension enforces the MVP container', () => {
  assert.equal(withMp4Extension('/out/game.mp4'), '/out/game.mp4');
  assert.equal(withMp4Extension('/out/GAME.MP4'), '/out/GAME.MP4');
  assert.equal(withMp4Extension('/out/game.mov'), '/out/game.mp4');
  assert.equal(withMp4Extension('/out/game'), '/out/game.mp4');
  assert.throws(() => withMp4Extension(''), /non-empty/);
});

test('buildFilterGraph places sparse segments with the MVP mix', () => {
  const { filterComplex, audioMapLabel } = buildFilterGraph({
    segments: [{ startMs: 3000 }, { startMs: 10000 }],
    hasGameAudio: true,
  });
  assert.equal(audioMapLabel, '[out]');
  assert.ok(filterComplex.includes('[0:a]'), 'game input');
  assert.ok(filterComplex.includes(`volume=${EXPORT_MIX.gameGain}[game]`), 'game gain');
  assert.ok(filterComplex.includes('[1:a]'), 'first commentary input');
  assert.ok(filterComplex.includes('adelay=3000:all=1'), 'first offset');
  assert.ok(filterComplex.includes('adelay=10000:all=1'), 'second offset');
  assert.ok(filterComplex.includes(`volume=${EXPORT_MIX.commentaryGain}[c1]`), 'commentary gain');
  assert.ok(
    filterComplex.includes('amix=inputs=3:duration=first:dropout_transition=0:normalize=0'),
    'bounded mix',
  );
  assert.ok(filterComplex.includes(`alimiter=limit=${EXPORT_MIX.limiterCeiling}[out]`), 'ceiling');
});

test('buildFilterGraph handles missing game audio and single inputs', () => {
  const silent = buildFilterGraph({ segments: [{ startMs: 0 }, { startMs: 5000 }], hasGameAudio: false });
  assert.ok(silent.filterComplex.includes('amix=inputs=2:duration=longest'), 'longest without game');
  assert.ok(!silent.filterComplex.includes('[0:a]'), 'no game input');
  const single = buildFilterGraph({ segments: [{ startMs: 1000 }], hasGameAudio: false });
  assert.ok(!single.filterComplex.includes('amix='), 'single input skips the mixer');
  assert.ok(single.filterComplex.includes('adelay=1000:all=1'), 'offset kept');
  assert.throws(() => buildFilterGraph({ segments: [], hasGameAudio: true }), /at least one/);
});

test('buildExportArgv assembles a shell-free command', () => {
  const argv = buildExportArgv({
    sourcePath: '/proj/source/match.mp4',
    wavPaths: ['/proj/output/audio/segments/u-0001.wav'],
    segments: [{ startMs: 3000 }],
    hasGameAudio: true,
    durationSeconds: 30,
    outputPath: '/tmp/out.mp4',
  });
  assert.ok(Array.isArray(argv));
  assert.equal(argv[argv.length - 1], '/tmp/out.mp4');
  assert.equal(argv[argv.length - 2], '-y');
  const filterIndex = argv.indexOf('-filter_complex');
  assert.ok(filterIndex > 0 && typeof argv[filterIndex + 1] === 'string');
  assert.deepEqual(argv.slice(argv.indexOf('-map'), argv.indexOf('-map') + 4), [
    '-map',
    '0:v:0',
    '-map',
    '[out]',
  ]);
  assert.ok(argv.includes('copy') && argv.includes('aac'));
  assert.equal(argv[argv.indexOf('-t') + 1], '30');
  // Hostile-looking paths stay single argv entries (spawned, never shelled).
  const tricky = buildExportArgv({
    sourcePath: '/v/my match; rm.mp4',
    wavPaths: ['/a/u 1.wav'],
    segments: [{ startMs: 0 }],
    hasGameAudio: false,
    durationSeconds: 6,
    outputPath: '/o/out put.mp4',
  });
  assert.ok(tricky.includes('/v/my match; rm.mp4'));
  assert.ok(tricky.includes('/a/u 1.wav'));
  assert.equal(tricky[tricky.length - 1], '/o/out put.mp4');
  assert.throws(
    () => buildExportArgv({ sourcePath: '', wavPaths: ['a'], segments: [{}], hasGameAudio: true, durationSeconds: 1, outputPath: 'o' }),
    /source video/,
  );
});
