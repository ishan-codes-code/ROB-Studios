import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for project media release. There is no JSX harness in
// this repo, so these tests verify the renderer sources release their
// media handles on detach: a <video> element that keeps its source
// holds the file open in Chromium, and on Windows that lock turns
// project deletion into EBUSY/EPERM failures.
const here = path.dirname(fileURLToPath(import.meta.url));
const preview = fs.readFileSync(
  path.join(here, '../src/app/sections/workspace/VideoPreview.jsx'),
  'utf8',
);
const scriptPanel = fs.readFileSync(
  path.join(here, '../src/app/sections/workspace/ScriptPanel.jsx'),
  'utf8',
);

test('video preview releases its media element on detach', () => {
  // Pause, drop every source reference, then load() to flush the
  // media pipeline and its file handle.
  assert.match(preview, /function releaseVideoElement\(node\)/);
  assert.match(preview, /node\.pause\(\)/);
  assert.match(preview, /node\.removeAttribute\("src"\)/);
  assert.match(preview, /node\.load\(\)/);
});

test('video preview cleanup runs for remounts as well as unmounts', () => {
  // The keyed <video> element is replaced on source change; a React 19
  // ref-detach cleanup catches both that swap and full unmounts.
  assert.match(preview, /key=\{sourcePath\}/);
  assert.match(preview, /if \(!node\) return undefined;/);
  assert.match(preview, /return \(\) => \{\s*releaseVideoElement\(node\);/);
});

test('video preview clears forwarded refs when the element detaches', () => {
  assert.match(preview, /internalVideoRef\.current = null;/);
  assert.match(preview, /videoRef\(null\)/);
  assert.match(preview, /videoRef\.current = null;/);
});

test('script panel keeps its preview-audio unmount cleanup', () => {
  assert.match(scriptPanel, /useEffect\(\(\) => \(\) => \{/);
  assert.match(scriptPanel, /element\.pause\(\)/);
  assert.match(scriptPanel, /element\.removeAttribute\("src"\)/);
  assert.match(scriptPanel, /previewRef\.current = null;/);
});

test('video preview ref callback is stable across renders', () => {
  // A fresh callback identity every render would make React 19 run
  // the detach cleanup (which strips the video src) on ordinary state
  // updates, wedging the preview on 'loading' with no further events.
  assert.match(preview, /const setVideoRef = useCallback\(\(node\) => \{/);
  assert.match(preview, /\}, \[videoRef\]\);/);
});

