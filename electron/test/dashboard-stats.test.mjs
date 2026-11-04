import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeArtifacts,
  firstFrameName,
  hasAnalysisOutput,
  hasCommentaryOutput,
  summarizeDashboard,
} from '../src/lib/dashboard-stats.js';

const valid = (extra = {}) => ({ present: true, invalid: false, ...extra });
const absent = () => ({ present: false, invalid: false });

test('analysis output requires a confirmed manifest, events, or observations', () => {
  assert.equal(hasAnalysisOutput(null), false);
  assert.equal(hasAnalysisOutput({}), false);
  assert.equal(hasAnalysisOutput({ manifest: valid() }), true);
  assert.equal(hasAnalysisOutput({ events: valid({ count: 4 }) }), true);
  assert.equal(hasAnalysisOutput({ observations: { count: 3 } }), true);
  assert.equal(hasAnalysisOutput({ observations: { count: 0 } }), false);
  assert.equal(hasAnalysisOutput({ manifest: { present: true, invalid: true } }), false);
  assert.equal(hasAnalysisOutput({ events: { present: true, invalid: true, count: 9 } }), false);
});

test('commentary output requires lines or a script document', () => {
  assert.equal(hasCommentaryOutput(null), false);
  assert.equal(hasCommentaryOutput({}), false);
  assert.equal(hasCommentaryOutput({ commentary: valid({ lines: 12 }) }), true);
  assert.equal(hasCommentaryOutput({ commentary: valid({ lines: 0 }) }), false);
  assert.equal(hasCommentaryOutput({ script: valid({ status: 'success' }) }), true);
  assert.equal(
    hasCommentaryOutput({ commentary: { present: true, invalid: true, lines: 12 } }),
    false,
  );
});

test('summary counts only projects with confirmed output', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const listings = new Map([
    ['a', { events: valid({ count: 2 }), commentary: valid({ lines: 5 }) }],
    ['b', { manifest: valid(), commentary: absent() }],
  ]);
  assert.deepEqual(summarizeDashboard(projects, listings), {
    projects: 3,
    analyses: 2,
    commentaries: 1,
  });
});

test('summary accepts plain-object listings and tolerates garbage', () => {
  const projects = [{ id: 'a' }, null, { id: 'b' }];
  assert.deepEqual(
    summarizeDashboard(projects, { a: { script: valid() } }),
    { projects: 3, analyses: 0, commentaries: 1 },
  );
  assert.deepEqual(summarizeDashboard(null), { projects: 0, analyses: 0, commentaries: 0 });
  assert.deepEqual(summarizeDashboard([{ id: 'a' }]), {
    projects: 0 + 1,
    analyses: 0,
    commentaries: 0,
  });
});

test('first frame name is validated before thumbnail use', () => {
  assert.equal(firstFrameName(null), null);
  assert.equal(firstFrameName({}), null);
  assert.equal(firstFrameName({ frames: { count: 0, items: [] } }), null);
  assert.equal(
    firstFrameName({ frames: { count: 1, items: [{ name: 'frame_12.jpg' }] } }),
    'frame_12.jpg',
  );
  assert.equal(
    firstFrameName({ frames: { count: 1, items: [{ name: '../evil.png' }] } }),
    null,
  );
  assert.equal(
    firstFrameName({ frames: { count: 1, items: [{ name: 42 }] } }),
    null,
  );
});

test('artifact chips describe confirmed output only', () => {
  assert.deepEqual(describeArtifacts(null), []);
  assert.deepEqual(describeArtifacts({}), []);
  assert.deepEqual(
    describeArtifacts({
      events: valid({ count: 1 }),
      commentary: valid({ lines: 7 }),
      script: valid({ status: 'success' }),
    }),
    [
      { key: 'events', label: '1 event' },
      { key: 'lines', label: '7 lines' },
      { key: 'script', label: 'script' },
    ],
  );
  assert.deepEqual(
    describeArtifacts({
      events: { present: true, invalid: true, count: 9 },
      commentary: valid({ lines: 0 }),
    }),
    [],
  );
});
