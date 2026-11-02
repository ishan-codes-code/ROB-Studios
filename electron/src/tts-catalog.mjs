// Backend-provided TTS catalogue loader (Electron main process).
//
// The Python `tts_catalog.py` probe is the single source of truth for TTS
// models, prebuilt voices, defaults, and limits. This loader spawns it,
// validates the untrusted probe output, and caches the result for the
// application session (the catalogue only changes with code updates, so
// no TTL is needed). The renderer must never hardcode its own copy.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolvePythonExecutable } from './worker-protocol.mjs';
import { normalizeTtsCatalog } from './tts-config.mjs';

export const TTS_CATALOG_TIMEOUT_MS = 25000;
const MAX_OUTPUT_CHARS = 65536;

export function ttsCatalogScript(repoRoot) {
  return path.join(repoRoot, 'python', 'tts_catalog.py');
}

/** Parse bounded probe stdout: the last line must be the catalogue JSON. */
export function parseCatalogOutput(output) {
  const line = String(output ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('TTS catalogue returned an invalid response.');
  }
  return normalizeTtsCatalog(parsed);
}

function runProbe({ executable, script, spawnFn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(executable, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      reject(new Error('Could not start the TTS catalogue probe.'));
      return;
    }
    let output = '';
    let settled = false;
    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(...args);
    };
    const done = finish(resolve);
    const fail = finish(reject);
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      fail(new Error('TTS catalogue request timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk).slice(0, MAX_OUTPUT_CHARS - output.length);
    });
    child.on('error', () => fail(new Error('Could not start the TTS catalogue probe.')));
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error('TTS catalogue probe failed. Check the Python environment.'));
        return;
      }
      try {
        done(parseCatalogOutput(output));
      } catch (err) {
        fail(err);
      }
    });
  });
}

export function createTtsCatalogLoader({ repoRoot, spawnFn = spawn, timeoutMs = TTS_CATALOG_TIMEOUT_MS } = {}) {
  let cached = null;
  return {
    async load() {
      if (cached) return cached;
      const root = typeof repoRoot === 'function' ? repoRoot() : repoRoot;
      const { executable } = resolvePythonExecutable(root);
      if (!executable) {
        throw new Error('Python virtual environment is not configured.');
      }
      cached = await runProbe({
        executable,
        script: ttsCatalogScript(root),
        spawnFn,
        timeoutMs,
      });
      return cached;
    },
    reset() {
      cached = null;
    },
  };
}
