import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequired,
  validateName,
  validateKeyInput,
  validateModelInput,
  validateEndpointInput,
} from '../src/lib/config-validation.js';

test('required and name fields bound their input', () => {
  assert.equal(validateRequired('  x ', 'Thing'), null);
  assert.equal(validateRequired('   ', 'Thing'), 'Thing is required.');
  assert.equal(validateName('Meta Personal'), null);
  assert.equal(validateName(''), 'Name is required.');
  assert.match(validateName('x'.repeat(81)), /80 characters/);
});

test('key input stays non-empty and bounded', () => {
  assert.equal(validateKeyInput('secret'), null);
  assert.match(validateKeyInput(''), /API key/);
  assert.match(validateKeyInput('x'.repeat(4097)), /4096/);
});

test('model input stays a bounded single line', () => {
  assert.equal(validateModelInput('qwen-vl'), null);
  assert.match(validateModelInput(''), /required/);
  assert.match(validateModelInput('x'.repeat(201)), /200 characters/);
  assert.match(validateModelInput('bad\nid'), /invalid characters/);
});

test('endpoint input mirrors the main-process URL rules', () => {
  assert.equal(validateEndpointInput('https://llm.example.com/v1'), null);
  assert.match(validateEndpointInput('http://llm.example.com/v1'), /HTTPS/);
  assert.match(validateEndpointInput('https://u:p@llm.example.com/v1'), /HTTPS/);
  assert.match(validateEndpointInput('https://localhost/v1'), /local or private/);
  assert.match(validateEndpointInput('https://10.0.0.5/v1'), /local or private/);
  assert.match(validateEndpointInput('not-a-url'), /valid HTTPS URL/);
  assert.match(validateEndpointInput(''), /required/);
});
