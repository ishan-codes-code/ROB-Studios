import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStopControlLine,
  buildWorkerArgv,
  createLineParser,
  describeWorkerMessageIssue,
  isValidAdaptiveSample,
  isValidScriptSegment,
  isValidTtsSegment,
  isValidWorkerMessage,
  isVisionConfigured,
  resolvePythonExecutable,
  resolveWorkerScript,
  validateVideoInput,
  WORKER_CONTROL_VERSION,
} from '../src/worker-protocol.mjs';

test('parser assembles a message split across chunks', () => {
  const seen = [];
  const parser = createLineParser({ onMessage: (m) => seen.push(m) });
  assert.deepEqual(parser.feed('{"type": "star'), []);
  assert.deepEqual(parser.feed('ted", "message": "hi"}\n'), [
    { type: 'started', message: 'hi' },
  ]);
  assert.deepEqual(seen, [{ type: 'started', message: 'hi' }]);
});

test('parser handles several messages in one chunk and CRLF', () => {
  const seen = [];
  const parser = createLineParser({ onMessage: (m) => seen.push(m) });
  const out = parser.feed(
    '{"type":"progress","stage":"a"}\r\n\r\n{"type":"result","data":{}}\n',
  );
  assert.equal(out.length, 2);
  assert.deepEqual(seen, out);
});

test('parser skips invalid lines and keeps going', () => {
  const seen = [];
  const invalid = [];
  const parser = createLineParser({
    onMessage: (m) => seen.push(m),
    onInvalid: (line) => invalid.push(line),
  });
  const out = parser.feed('FPS: 12.50\n{"type":"progress","stage":"a"}\n');
  assert.deepEqual(out, [{ type: 'progress', stage: 'a' }]);
  assert.deepEqual(invalid, ['FPS: 12.50']);
  assert.equal(parser.invalidLines(), 1);
});

test('flush dispatches a final unterminated line', () => {
  const parser = createLineParser({});
  assert.deepEqual(parser.feed('{"type":"started"}\n'), [{ type: 'started' }]);
  assert.deepEqual(parser.flush(), []);
  parser.feed('{"type":"result","data":{}}');
  assert.deepEqual(parser.flush(), [{ type: 'result', data: {} }]);
  assert.deepEqual(parser.flush(), []);
});

test('validateVideoInput accepts supported extensions case-insensitively', () => {
  assert.equal(validateVideoInput('clip.MP4'), null);
  assert.equal(validateVideoInput('/tmp/a/b.webm'), null);
  assert.match(validateVideoInput(''), /non-empty/);
  assert.match(validateVideoInput(42), /non-empty/);
  assert.match(validateVideoInput('clip.txt'), /Unsupported/);
  assert.match(validateVideoInput('noextension'), /Unsupported/);
  // Path traversal shape is the worker's problem to reject by existence;
  // the IPC layer only enforces type and extension.
  assert.equal(validateVideoInput('../other/clip.mp4'), null);
});

test('isValidWorkerMessage accepts only known types', () => {
  assert.equal(isValidWorkerMessage({ type: 'started' }), true);
  assert.equal(isValidWorkerMessage({ type: 'result', data: {} }), true);
  assert.equal(isValidWorkerMessage({ type: 'nope' }), false);
  assert.equal(isValidWorkerMessage(null), false);
  assert.equal(isValidWorkerMessage('started'), false);
});

function validSample(overrides = {}) {
  return {
    type: 'adaptive_sample',
    data: {
      timestamp: 12.5,
      speed: 'HIGH',
      reason: 'Fast motion.',
      next_timestamp: 13,
      observations: 3,
      requests: 3,
      ...overrides,
    },
  };
}

test('adaptive_sample accepts a complete valid payload', () => {
  assert.equal(isValidAdaptiveSample(validSample()), true);
  assert.equal(isValidWorkerMessage(validSample()), true);
  assert.equal(
    isValidAdaptiveSample(validSample({ next_timestamp: null })),
    true,
  );
  assert.equal(isValidAdaptiveSample(validSample({ reason: '' })), true);
});

test('adaptive_sample rejects an invalid speed enum', () => {
  for (const speed of ['high', 'TURBO', '', null, 3, undefined]) {
    assert.equal(isValidAdaptiveSample(validSample({ speed })), false);
  }
  assert.equal(isValidWorkerMessage(validSample({ speed: 'nope' })), false);
});

test('adaptive_sample rejects bad timestamps and counters', () => {
  assert.equal(isValidAdaptiveSample(validSample({ timestamp: -1 })), false);
  assert.equal(isValidAdaptiveSample(validSample({ timestamp: NaN })), false);
  assert.equal(
    isValidAdaptiveSample(validSample({ timestamp: Infinity })),
    false,
  );
  assert.equal(isValidAdaptiveSample(validSample({ timestamp: '12' })), false);
  assert.equal(
    isValidAdaptiveSample(validSample({ next_timestamp: -0.5 })),
    false,
  );
  assert.equal(
    isValidAdaptiveSample(validSample({ next_timestamp: 'soon' })),
    false,
  );
  assert.equal(isValidAdaptiveSample(validSample({ observations: -1 })), false);
  assert.equal(isValidAdaptiveSample(validSample({ requests: 1.5 })), false);
  assert.equal(
    isValidAdaptiveSample(validSample({ observations: '3' })),
    false,
  );
});

test('adaptive_sample rejects a bad or over-long reason', () => {
  assert.equal(isValidAdaptiveSample(validSample({ reason: null })), false);
  assert.equal(isValidAdaptiveSample(validSample({ reason: 7 })), false);
  assert.equal(
    isValidAdaptiveSample(validSample({ reason: 'x'.repeat(281) })),
    false,
  );
  assert.equal(
    isValidAdaptiveSample(validSample({ reason: 'x'.repeat(280) })),
    true,
  );
});

test('adaptive_sample rejects missing or malformed envelopes', () => {
  assert.equal(isValidAdaptiveSample(null), false);
  assert.equal(isValidAdaptiveSample({ type: 'started' }), false);
  assert.equal(isValidAdaptiveSample({ type: 'adaptive_sample' }), false);
  assert.equal(
    isValidAdaptiveSample({ type: 'adaptive_sample', data: null }),
    false,
  );
  assert.equal(
    isValidWorkerMessage({ type: 'adaptive_sample', data: {} }),
    false,
  );
});

function validScriptSegment(overrides = {}) {
  return {
    type: 'script_segment',
    data: {
      utterance_id: 'u-0001',
      timestamp_seconds: 12.5,
      text: 'The zone starts closing in.',
      source_claim_ids: ['clm-9f3a2b1c4d5e'],
      priority: 1,
      status: 'worded',
      ...overrides,
    },
  };
}

function validTtsSegment(overrides = {}) {
  return {
    type: 'tts_segment',
    data: {
      utterance_id: 'u-0001',
      timestamp_seconds: 12.5,
      status: 'success',
      error: null,
      ...overrides,
    },
  };
}

test('script_segment accepts worded and superseded payloads', () => {
  assert.equal(isValidScriptSegment(validScriptSegment()), true);
  assert.equal(isValidScriptSegment(validScriptSegment({ status: 'superseded' })), true);
  assert.equal(isValidWorkerMessage(validScriptSegment()), true);
  assert.equal(isValidWorkerMessage({ type: 'script_segment' }), false);
});

test('script_segment rejects malformed payloads', () => {
  assert.equal(isValidScriptSegment(validScriptSegment({ utterance_id: '' })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ timestamp_seconds: -1 })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ text: '  ' })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ text: 'x'.repeat(601) })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ source_claim_ids: [] })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ source_claim_ids: ['ok', 42] })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ priority: 3 })), false);
  assert.equal(isValidScriptSegment(validScriptSegment({ status: 'draft' })), false);
  assert.equal(isValidWorkerMessage(validScriptSegment({ priority: 9 })), false);
});

test('tts_segment accepts outcomes and rejects malformed payloads', () => {
  assert.equal(isValidTtsSegment(validTtsSegment()), true);
  assert.equal(
    isValidTtsSegment(validTtsSegment({ status: 'error', error: 'Synth failed.' })),
    true,
  );
  assert.equal(isValidTtsSegment(validTtsSegment({ status: 'skipped' })), true);
  assert.equal(isValidTtsSegment(validTtsSegment({ status: 'started', error: null })), true);
  assert.equal(isValidWorkerMessage(validTtsSegment({ status: 'started' })), true);
  assert.equal(isValidWorkerMessage(validTtsSegment()), true);
  assert.equal(isValidTtsSegment(validTtsSegment({ utterance_id: '' })), false);
  assert.equal(isValidTtsSegment(validTtsSegment({ status: 'queued' })), false);
  assert.equal(isValidTtsSegment(validTtsSegment({ error: 42 })), false);
  assert.equal(isValidWorkerMessage(validTtsSegment({ status: 'nope' })), false);
});

test('describeWorkerMessageIssue separates unknown types from bad payloads', () => {
  assert.equal(describeWorkerMessageIssue({ type: 'started' }), null);
  assert.equal(describeWorkerMessageIssue(validTtsSegment()), null);
  assert.equal(describeWorkerMessageIssue(validTtsSegment({ status: 'started' })), null);
  assert.deepEqual(describeWorkerMessageIssue({ type: 'mystery' }), {
    kind: 'unknown-type',
    type: 'mystery',
  });
  assert.deepEqual(describeWorkerMessageIssue(null), { kind: 'unknown-type', type: null });
  assert.deepEqual(describeWorkerMessageIssue({ type: 42 }), {
    kind: 'unknown-type',
    type: null,
  });
  assert.deepEqual(describeWorkerMessageIssue(validTtsSegment({ status: 'queued' })), {
    kind: 'invalid-payload',
    type: 'tts_segment',
  });
  assert.deepEqual(describeWorkerMessageIssue(validScriptSegment({ status: 'draft' })), {
    kind: 'invalid-payload',
    type: 'script_segment',
  });
  // Untrusted payload data never travels into the diagnostic, and
  // overlong types are capped.
  const sneaky = validTtsSegment({ status: 'queued', error: 'sk-SECRET-VALUE' });
  const issue = describeWorkerMessageIssue(sneaky);
  assert.equal(issue.kind, 'invalid-payload');
  assert.ok(!JSON.stringify(issue).includes('SECRET'));
  const long = describeWorkerMessageIssue({ type: `x${'y'.repeat(500)}` });
  assert.equal(long.kind, 'unknown-type');
  assert.equal(long.type.length, 120);
});

test('resolvePythonExecutable reports the venv interpreter or its absence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-resolve-'));
  try {
    const missing = resolvePythonExecutable(tmp);
    assert.equal(missing.executable, null);
    assert.match(missing.missing, /\.venv/);

    const binDir =
      process.platform === 'win32'
        ? path.join(tmp, '.venv', 'Scripts')
        : path.join(tmp, '.venv', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe =
      process.platform === 'win32'
        ? path.join(binDir, 'python.exe')
        : path.join(binDir, 'python');
    fs.writeFileSync(exe, '');
    const found = resolvePythonExecutable(tmp);
    assert.equal(found.executable, exe);
    assert.equal(found.source, 'venv');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveWorkerScript reports presence or absence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-resolve-'));
  try {
    const missing = resolveWorkerScript(tmp);
    assert.equal(missing.script, null);
    assert.match(missing.missing, /worker\.py/);

    fs.mkdirSync(path.join(tmp, 'python'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'python', 'worker.py'), '');
    const found = resolveWorkerScript(tmp);
    assert.ok(found.script.endsWith('worker.py'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('control channel carries a versioned stop line', () => {
  assert.equal(WORKER_CONTROL_VERSION, 1);
  assert.equal(buildStopControlLine(), '{"type":"stop","version":1}\n');
  assert.deepEqual(JSON.parse(buildStopControlLine()), { type: 'stop', version: 1 });
});

test('stopped is a known worker message type', () => {
  assert.equal(isValidWorkerMessage({ type: 'stopped', data: {} }), true);
});

test('buildWorkerArgv passes adaptive flags', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      adaptive: true,
      adaptiveMaxFrames: 3,
    }),
    ['worker.py', 'clip.mp4', '--adaptive', '--adaptive-max-frames', '3'],
  );
});

test('buildWorkerArgv rejects non-positive adaptiveMaxFrames', () => {
  for (const adaptiveMaxFrames of [0, -2, 2.5, 'many', NaN]) {
    assert.throws(
      () => buildWorkerArgv('worker.py', 'clip.mp4', { adaptiveMaxFrames }),
      /positive integer/,
    );
  }
});

test('buildWorkerArgv rejects explicit bounds above the engine hard cap', () => {
  for (const adaptiveMaxFrames of [10001, 10 ** 9, '20000']) {
    assert.throws(
      () => buildWorkerArgv('worker.py', 'clip.mp4', { adaptiveMaxFrames }),
      /up to 10000/,
    );
  }
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', { adaptive: true, adaptiveMaxFrames: 10000 }),
    ['worker.py', 'clip.mp4', '--adaptive', '--adaptive-max-frames', '10000'],
  );
});

test('buildWorkerArgv omits the flag for unlimited runs', () => {
  for (const adaptiveMaxFrames of [null, undefined]) {
    assert.deepEqual(
      buildWorkerArgv('worker.py', 'clip.mp4', { adaptive: true, adaptiveMaxFrames }),
      ['worker.py', 'clip.mp4', '--adaptive'],
    );
  }
});

test('buildWorkerArgv omits vision flags when not adaptive', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      outputDir: '/out',
    }),
    ['worker.py', 'clip.mp4', '--output-dir', '/out'],
  );
});

test('buildWorkerArgv never invents flags from unknown options', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      limit: 10,
      skipVision: true,
      extra: '--exec-evil',
    }),
    ['worker.py', 'clip.mp4'],
  );
});

test('buildWorkerArgv passes the script flag', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      adaptive: true,
      withScript: true,
    }),
    ['worker.py', 'clip.mp4', '--with-script', '--adaptive'],
  );
});

test('buildWorkerArgv passes TTS flags with a validated voice triple', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      adaptive: true,
      withScript: true,
      generateTts: true,
      ttsModel: 'gemini-3.8-flash-tts',
      ttsVoice: 'Fenrir',
      ttsVoiceDirection: 'Calm and measured.',
    }),
    [
      'worker.py', 'clip.mp4', '--with-script', '--generate-tts',
      '--tts-model', 'gemini-3.8-flash-tts',
      '--tts-voice', 'Fenrir',
      '--tts-voice-direction', 'Calm and measured.',
      '--adaptive',
    ],
  );
});

test('buildWorkerArgv rejects TTS without the script and unbounded values', () => {
  assert.throws(
    () => buildWorkerArgv('worker.py', 'clip.mp4', { generateTts: true }),
    /requires --with-script/,
  );
  assert.throws(
    () => buildWorkerArgv('worker.py', 'clip.mp4', { ttsVoice: '' }),
    /ttsVoice must be a non-empty string/,
  );
  assert.throws(
    () => buildWorkerArgv('worker.py', 'clip.mp4', { ttsVoice: 'v'.repeat(65) }),
    /ttsVoice must be a non-empty string/,
  );
  assert.throws(
    () => buildWorkerArgv('worker.py', 'clip.mp4', { ttsVoiceDirection: 'd'.repeat(501) }),
    /ttsVoiceDirection must be a non-empty string/,
  );
});

test('buildWorkerArgv passes the streaming flag', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      adaptive: true,
      streaming: true,
    }),
    ['worker.py', 'clip.mp4', '--streaming', '--adaptive'],
  );
});

test('buildWorkerArgv allows TTS with streaming but not alone', () => {
  assert.deepEqual(
    buildWorkerArgv('worker.py', 'clip.mp4', {
      adaptive: true,
      streaming: true,
      generateTts: true,
    }),
    ['worker.py', 'clip.mp4', '--streaming', '--generate-tts', '--adaptive'],
  );
  assert.throws(
    () => buildWorkerArgv('worker.py', 'clip.mp4', { generateTts: true }),
    /requires --with-script/,
  );
});

test('isVisionConfigured reads only presence of the key', () => {
  assert.equal(isVisionConfigured({ BASETEN_API_KEY: 'secret' }), true);
  assert.equal(isVisionConfigured({ BASETEN_API_KEY: '  ' }), false);
  assert.equal(isVisionConfigured({}), false);
  assert.equal(isVisionConfigured(null), false);
});
