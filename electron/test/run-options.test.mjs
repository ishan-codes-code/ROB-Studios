import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTIVE_HARD_MAX_FRAMES,
  RUN_MODES,
  buildProcessOptions,
  clampAdaptiveMaxFrames,
  defaultRunMode,
  isAdaptiveMode,
  isValidAdaptiveMaxFrames,
} from '../src/lib/run-options.js';

test('adaptive is the only run mode', () => {
  assert.deepEqual(Object.keys(RUN_MODES), ['ADAPTIVE']);
  assert.equal(isAdaptiveMode(RUN_MODES.ADAPTIVE), true);
  assert.equal(isAdaptiveMode('mystery'), false);
  assert.equal(defaultRunMode(), RUN_MODES.ADAPTIVE);
});

test('adaptive options default to unlimited vision requests', () => {
  assert.deepEqual(buildProcessOptions(RUN_MODES.ADAPTIVE), {
    adaptive: true,
    adaptiveMaxFrames: null,
    withScript: false,
    streaming: true,
    requestTts: false,
  });
  assert.deepEqual(
    buildProcessOptions(RUN_MODES.ADAPTIVE, { adaptiveMaxFrames: 5 }),
    { adaptive: true, adaptiveMaxFrames: 5, withScript: false, streaming: true, requestTts: false },
  );
  // Fractions floor; the hard cap holds; nothing silently becomes a
  // numeric default — invalid input normalizes to unlimited (null).
  assert.equal(
    buildProcessOptions(RUN_MODES.ADAPTIVE, { adaptiveMaxFrames: 5.9 })
      .adaptiveMaxFrames,
    5,
  );
  assert.equal(
    buildProcessOptions(RUN_MODES.ADAPTIVE, { adaptiveMaxFrames: 10 ** 9 })
      .adaptiveMaxFrames,
    ADAPTIVE_HARD_MAX_FRAMES,
  );
  for (const unlimited of [null, undefined, '']) {
    assert.equal(
      buildProcessOptions(RUN_MODES.ADAPTIVE, { adaptiveMaxFrames: unlimited })
        .adaptiveMaxFrames,
      null,
    );
  }
  for (const bad of [0, -3, 'many', NaN]) {
    assert.equal(
      buildProcessOptions(RUN_MODES.ADAPTIVE, { adaptiveMaxFrames: bad })
        .adaptiveMaxFrames,
      null,
    );
  }
});

test('invalid bounds are detectable so the UI can reject them', () => {
  for (const good of [null, undefined, '', '   ', 1, 5, '7', ' 12 ', 5.9, 10 ** 9]) {
    assert.equal(isValidAdaptiveMaxFrames(good), true, JSON.stringify(good));
  }
  for (const bad of [0, -3, NaN, 'many', '0', '-3']) {
    assert.equal(isValidAdaptiveMaxFrames(bad), false, JSON.stringify(bad));
  }
});

test('streaming is the standard experience; audio needs no script toggle', () => {
  const plain = buildProcessOptions(RUN_MODES.ADAPTIVE, {});
  assert.equal(plain.streaming, true);
  assert.equal(plain.withScript, false);
  assert.equal(plain.requestTts, false);
  // One checkbox: audio passes through whenever checked (streaming
  // always words the script underneath; the main process re-checks).
  const audio = buildProcessOptions(RUN_MODES.ADAPTIVE, { requestTts: true });
  assert.equal(audio.streaming, true);
  assert.equal(audio.withScript, false);
  assert.equal(audio.requestTts, true);
});

test('explicit sequential fallback stays available internally', () => {
  const sequential = buildProcessOptions(RUN_MODES.ADAPTIVE, { streaming: false });
  assert.equal(sequential.streaming, false);
  assert.equal(sequential.requestTts, false);
  const sequentialScript = buildProcessOptions(RUN_MODES.ADAPTIVE, { streaming: false, withScript: true, requestTts: true });
  assert.equal(sequentialScript.withScript, true);
  assert.equal(sequentialScript.requestTts, true);
  // Audio without the script or streaming is coerced off.
  const audioAlone = buildProcessOptions(RUN_MODES.ADAPTIVE, { streaming: false, requestTts: true });
  assert.equal(audioAlone.requestTts, false);
});

test('clamp keeps bounds inside the engine hard cap', () => {
  assert.equal(ADAPTIVE_HARD_MAX_FRAMES, 10000);
  assert.equal(clampAdaptiveMaxFrames(1), 1);
  assert.equal(clampAdaptiveMaxFrames('7'), 7);
  assert.equal(clampAdaptiveMaxFrames(' 12 '), 12);
  assert.equal(clampAdaptiveMaxFrames(null), null);
  assert.equal(clampAdaptiveMaxFrames(undefined), null);
  assert.equal(clampAdaptiveMaxFrames(''), null);
});
