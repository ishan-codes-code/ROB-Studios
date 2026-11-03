import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_STATUS,
  credentialStatus,
  statusMeta,
  summarizeCredentials,
} from '../src/lib/provider-status.js';

function record(overrides = {}) {
  return {
    id: 'cred-1',
    purpose: 'vision',
    model: 'muse-spark-1.3',
    keyAvailable: true,
    verification: { status: 'unverified' },
    ...overrides,
  };
}

test('missing records read as not connected', () => {
  assert.equal(credentialStatus(null), PROVIDER_STATUS.NOT_CONNECTED);
  assert.equal(credentialStatus(undefined), PROVIDER_STATUS.NOT_CONNECTED);
});

test('unreadable keys and failed checks need attention', () => {
  assert.equal(credentialStatus(record({ keyAvailable: false })), PROVIDER_STATUS.NEEDS_ATTENTION);
  assert.equal(credentialStatus(record(), { failedIds: ['cred-1'] }), PROVIDER_STATUS.NEEDS_ATTENTION);
  assert.equal(credentialStatus(record(), { failedIds: new Set(['cred-1']) }), PROVIDER_STATUS.NEEDS_ATTENTION);
});

test('verified vision outranks an ephemeral connection', () => {
  assert.equal(
    credentialStatus(record({ verification: { status: 'verified' } }), { connectedIds: ['cred-1'] }),
    PROVIDER_STATUS.VISION_VERIFIED,
  );
  assert.equal(credentialStatus(record(), { connectedIds: ['cred-1'] }), PROVIDER_STATUS.CONNECTED);
});

test('untested vision records with a model read as model selected', () => {
  assert.equal(credentialStatus(record()), PROVIDER_STATUS.MODEL_SELECTED);
  assert.equal(credentialStatus(record({ purpose: 'tts', model: null })), PROVIDER_STATUS.SAVED);
});

test('TTS verified wording never claims vision', () => {
  assert.deepEqual(statusMeta(PROVIDER_STATUS.VISION_VERIFIED, 'vision'), { label: 'Vision verified', variant: 'secondary' });
  assert.deepEqual(statusMeta(PROVIDER_STATUS.VISION_VERIFIED, 'tts'), { label: 'TTS access checked', variant: 'secondary' });
  assert.equal(statusMeta('bogus').label, 'Not connected');
});

test('summaries favor verified vision but surface lone problems', () => {
  assert.deepEqual(summarizeCredentials([]), {
    status: PROVIDER_STATUS.NOT_CONNECTED, verifiedCount: 0, total: 0, hasProblem: false,
  });
  assert.equal(summarizeCredentials([record({ purpose: 'tts', model: null })]).status, PROVIDER_STATUS.NOT_CONNECTED);
  const mixed = summarizeCredentials([
    record({ id: 'a', keyAvailable: false }),
    record({ id: 'b', verification: { status: 'verified' } }),
  ]);
  assert.equal(mixed.status, PROVIDER_STATUS.VISION_VERIFIED);
  assert.equal(mixed.verifiedCount, 1);
  assert.equal(mixed.hasProblem, true);
  const broken = summarizeCredentials([record({ keyAvailable: false })]);
  assert.equal(broken.status, PROVIDER_STATUS.NEEDS_ATTENTION);
});
