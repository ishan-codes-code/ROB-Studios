import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import ffmpegStaticPath from 'ffmpeg-static';
import { createExportManager } from '../src/export-runner.mjs';
import { parseProbeOutput, parseWavDuration } from '../src/export-media.mjs';
import { selectSingleChannel } from '../src/lib/commentary-timeline.js';

const execFileAsync = promisify(execFile);
const BINARY_AVAILABLE = typeof ffmpegStaticPath === 'string' && ffmpegStaticPath !== '';
const maybe = BINARY_AVAILABLE ? test : (name) => test(name, { skip: 'ffmpeg-static binary not installed' }, () => {});

async function runFfmpeg(argv) {
  try {
    await execFileAsync(ffmpegStaticPath, argv);
  } catch (err) {
    throw new Error(`ffmpeg fixture failed: ${String(err?.stderr ?? err?.message ?? err).slice(0, 500)}`);
  }
}

async function makeSource(dir, name, { duration = 8, audio = true } = {}) {
  const out = path.join(dir, name);
  const argv = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=d=${duration}:s=320x240:r=30`];
  if (audio) {
    argv.push('-f', 'lavfi', '-i', `sine=f=440:d=${duration}`);
  }
  argv.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) {
    argv.push('-c:a', 'aac', '-shortest');
  }
  argv.push('-y', out);
  await runFfmpeg(argv);
  return out;
}

async function makeWav(dir, name, { frequency = 880, seconds = 2 } = {}) {
  const out = path.join(dir, name);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=f=${frequency}:d=${seconds}`,
    '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', '-y', out,
  ]);
  return out;
}

async function probe(file) {
  try {
    await execFileAsync(ffmpegStaticPath, ['-hide_banner', '-i', file]);
  } catch (err) {
    return parseProbeOutput(String(err?.stderr ?? ''));
  }
  return parseProbeOutput('');
}

async function meanVolumeDb(file, start, length) {
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegStaticPath, [
      '-hide_banner', '-nostats', '-v', 'info',
      '-ss', String(start), '-t', String(length),
      '-i', file, '-af', 'volumedetect', '-f', 'null', '-',
    ]);
    stderr = String(result?.stderr ?? '');
  } catch (err) {
    stderr = String(err?.stderr ?? '');
  }
  const match = /mean_volume:\s*(-?[\d.]+|-\s*inf)\s*dB/.exec(stderr);
  if (match) {
    return match[1].includes('inf') ? Number.NEGATIVE_INFINITY : Number(match[1]);
  }
  return Number.NaN;
}

function planFrom(candidates, duration) {
  const audible = candidates
    .filter((item) => item.timestamp < duration)
    .map((item) => ({ ...item, start: item.timestamp, end: item.timestamp + item.duration }))
    .sort((a, b) => (a.start === b.start ? (a.wavPath < b.wavPath ? -1 : 1) : a.start - b.start));
  const { kept } = selectSingleChannel(audible);
  if (kept.length === 0) {
    throw new Error('No commentary falls within the video duration.');
  }
  return {
    wavPaths: kept.map((item) => item.wavPath),
    segments: kept.map((item) => ({ startMs: Math.round(item.start * 1000) })),
  };
}

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-export-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wavEntry(wavPath, timestamp) {
  const duration = parseWavDuration(fs.readFileSync(wavPath));
  return { wavPath, timestamp, duration };
}

maybe('full export mixes timestamped commentary over game audio', async (t) => {
  const dir = fixtureDir(t);
  const source = await makeSource(dir, 'src.mp4', { duration: 8 });
  const first = await makeWav(dir, 'u-0001.wav', { frequency: 880, seconds: 2 });
  const second = await makeWav(dir, 'u-0002.wav', { frequency: 660, seconds: 2 });
  const candidates = [wavEntry(first, 2), wavEntry(second, 5)];
  const output = path.join(dir, 'out.mp4');

  const manager = createExportManager();
  const events = [];
  const started = await manager.start({
    executable: ffmpegStaticPath,
    sourcePath: source,
    outputPath: output,
    resolvePlan: async ({ duration, hasAudio }) => ({
      ...planFrom(candidates, duration),
      hasGameAudio: hasAudio,
    }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(started.started, true);
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!manager.isBusy()) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });

  assert.deepEqual(events[events.length - 1], { phase: 'done', outputPath: output });
  assert.ok(events.some((event) => event.phase === 'progress'), 'progress reported');
  const probed = await probe(output);
  assert.equal(probed.hasVideo, true);
  assert.equal(probed.hasAudio, true);
  assert.equal(probed.videoCodec, 'h264');
  assert.ok(probed.duration !== null && Math.abs(probed.duration - 8) < 0.3, 'output keeps source length');

  const gameOnly = await meanVolumeDb(output, 0, 1);
  const mixed = await meanVolumeDb(output, 2.5, 1);
  const gap = await meanVolumeDb(output, 4.2, 0.5);
  assert.ok(Number.isFinite(gameOnly) && Number.isFinite(mixed), 'windows measurable');
  assert.ok(mixed > gameOnly + 2, `commentary audible in-window (${mixed} vs ${gameOnly} dB)`);
  assert.ok(Math.abs(gap - gameOnly) < 3, `gap preserves game bed (${gap} vs ${gameOnly} dB)`);
});

maybe('export works when the source has no audio track', async (t) => {
  const dir = fixtureDir(t);
  const source = await makeSource(dir, 'silent.mp4', { duration: 6, audio: false });
  const first = await makeWav(dir, 'u-0001.wav', { frequency: 880, seconds: 2 });
  const candidates = [wavEntry(first, 1)];
  const output = path.join(dir, 'out.mp4');

  const manager = createExportManager();
  const events = [];
  await manager.start({
    executable: ffmpegStaticPath,
    sourcePath: source,
    outputPath: output,
    resolvePlan: async ({ duration, hasAudio }) => ({
      ...planFrom(candidates, duration),
      hasGameAudio: hasAudio,
    }),
    onEvent: (event) => events.push(event),
  });
  while (manager.isBusy()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(events[events.length - 1], { phase: 'done', outputPath: output });
  const probed = await probe(output);
  assert.equal(probed.hasVideo, true);
  assert.equal(probed.hasAudio, true);
  assert.ok(probed.duration !== null && probed.duration <= 6.3, 'output capped at source length');
  const mixed = await meanVolumeDb(output, 1.5, 1);
  assert.ok(mixed > -40, `commentary present (${mixed} dB)`);
});

maybe('out-of-range segments never extend the output', async (t) => {
  const dir = fixtureDir(t);
  const source = await makeSource(dir, 'src.mp4', { duration: 6 });
  const first = await makeWav(dir, 'u-0001.wav', { frequency: 880, seconds: 2 });
  const far = await makeWav(dir, 'u-0002.wav', { frequency: 660, seconds: 2 });
  const candidates = [wavEntry(first, 1), wavEntry(far, 99)];
  const output = path.join(dir, 'out.mp4');

  const manager = createExportManager();
  const events = [];
  await manager.start({
    executable: ffmpegStaticPath,
    sourcePath: source,
    outputPath: output,
    resolvePlan: async ({ duration, hasAudio }) => ({
      ...planFrom(candidates, duration),
      hasGameAudio: hasAudio,
    }),
    onEvent: (event) => events.push(event),
  });
  while (manager.isBusy()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(events[events.length - 1], { phase: 'done', outputPath: output });
  const probed = await probe(output);
  assert.ok(probed.duration !== null && probed.duration <= 6.3, `output bounded (${probed.duration}s)`);
});

maybe('cancelling a real encode stops ffmpeg and removes the partial file', async (t) => {
  const dir = fixtureDir(t);
  const source = await makeSource(dir, 'long.mp4', { duration: 60 });
  const first = await makeWav(dir, 'u-0001.wav', { frequency: 880, seconds: 2 });
  const candidates = [wavEntry(first, 1)];
  const output = path.join(dir, 'out.mp4');

  const manager = createExportManager();
  const events = [];
  let sawProgress = false;
  await manager.start({
    executable: ffmpegStaticPath,
    sourcePath: source,
    outputPath: output,
    resolvePlan: async ({ duration, hasAudio }) => ({
      ...planFrom(candidates, duration),
      hasGameAudio: hasAudio,
    }),
    onEvent: (event) => {
      events.push(event);
      if (event.phase === 'progress') {
        sawProgress = true;
      }
    },
  });
  for (let i = 0; i < 200 && !sawProgress; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(sawProgress, 'encode produced progress before cancel');
  assert.equal(await manager.cancel({ killGraceMs: 500 }), true);
  for (let i = 0; i < 100 && manager.isBusy(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manager.isBusy(), false);
  assert.deepEqual(events[events.length - 1], { phase: 'cancelled' });
  assert.ok(!fs.existsSync(output), 'partial output removed');
});
