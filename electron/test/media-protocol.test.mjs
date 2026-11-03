import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { registerProjectMediaProtocol } from '../src/main/media-protocol.js';
import {
  createProject,
  getProjectOutputDir,
  resolveProjectMedia,
} from '../src/project-store.mjs';

let rootCounter = 0;

function makeUserData() {
  rootCounter += 1;
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), `ai-commentator-media-${process.pid}-${rootCounter}-`),
  );
  return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function seedProject(base) {
  const incoming = path.join(base, 'incoming');
  fs.mkdirSync(incoming, { recursive: true });
  const video = path.join(incoming, 'match.mp4');
  fs.writeFileSync(video, Buffer.alloc(1024, 7));
  const created = createProject(base, { name: 'Media', sourcePath: video });
  const segmentsDir = path.join(getProjectOutputDir(base, created.id), 'audio', 'segments');
  fs.mkdirSync(segmentsDir, { recursive: true });
  fs.writeFileSync(path.join(segmentsDir, 'u-0001.wav'), Buffer.alloc(64));
  return created;
}

function captureHandler(base) {
  let handler = null;
  const fetched = [];
  registerProjectMediaProtocol({
    protocol: { handle: (_scheme, fn) => { handler = fn; } },
    net: { fetch: (url) => { fetched.push(url); return `fetched:${url}`; } },
    pathToFileURL,
    app: { getPath: () => base },
    resolveProjectMedia,
  });
  assert.equal(typeof handler, 'function');
  return { handler, fetched };
}

test('project media protocol serves pipeline TTS segments', (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const created = seedProject(base);
  const { handler, fetched } = captureHandler(base);

  const res = handler({
    method: 'GET',
    url: `project://${created.id}/audio/segments/u-0001.wav`,
  });
  assert.equal(fetched.length, 1);
  assert.ok(String(res).startsWith('fetched:file:'));
  assert.ok(fetched[0].endsWith(path.join('output', 'audio', 'segments', 'u-0001.wav')));
});

test('project media protocol rejects unknown audio scopes and methods', (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const created = seedProject(base);
  const { handler, fetched } = captureHandler(base);

  const badScope = handler({
    method: 'GET',
    url: `project://${created.id}/audio/anything/u-0001.wav`,
  });
  assert.equal(badScope.status, 404);
  const missing = handler({
    method: 'GET',
    url: `project://${created.id}/audio/segments/absent.wav`,
  });
  assert.equal(missing.status, 404);
  const post = handler({
    method: 'POST',
    url: `project://${created.id}/audio/segments/u-0001.wav`,
  });
  assert.equal(post.status, 404);
  assert.equal(fetched.length, 0);
});
