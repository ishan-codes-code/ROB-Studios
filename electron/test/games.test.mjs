import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GAME_ID,
  GAMES,
  SUPPORTED_GAME_IDS,
  categoriesFor,
  gameDisplayName,
  getGame,
  isSupportedGameId,
  mapsFor,
  matchTypesFor,
  modesFor,
} from '../src/lib/games.js';

test('catalog holds exactly the three loaded games', () => {
  assert.deepEqual(SUPPORTED_GAME_IDS, ['free-fire', 'cod', 'bgmi']);
  assert.equal(DEFAULT_GAME_ID, 'free-fire');
  assert.equal(GAMES.length, 3);
  assert.equal(getGame('cod').name, 'Call of Duty');
  assert.equal(getGame('bgmi').shortName, 'BGMI');
  assert.equal(getGame('unknown'), null);
  assert.equal(isSupportedGameId('bgmi'), true);
  assert.equal(isSupportedGameId('valorant'), false);
  assert.equal(gameDisplayName('cod'), 'Call of Duty');
  assert.equal(gameDisplayName('unknown'), 'Free Fire');
});

test('match types and maps are suggested per game', () => {
  assert.deepEqual(matchTypesFor('free-fire'), ['Battle Royale', 'Clash Squad', 'Custom']);
  assert.deepEqual(matchTypesFor('cod'), ['Battle Royale', 'Multiplayer']);
  assert.deepEqual(matchTypesFor('bgmi'), ['Battle Royale', 'Custom Room']);
  assert.deepEqual(mapsFor('bgmi'), ['Erangel', 'Miramar', 'Sanhok', 'Vikendi']);
  assert.ok(mapsFor('free-fire').includes('Bermuda'));
  // Title-generic Call of Duty offers no map suggestions.
  assert.deepEqual(mapsFor('cod'), []);
  assert.deepEqual(categoriesFor('bgmi'), ['Ranked', 'Casual', 'Tournament']);
  assert.deepEqual(matchTypesFor('unknown'), []);
});

test('modes are conditional on the match type', () => {
  assert.deepEqual(modesFor('free-fire', 'Battle Royale'), ['Solo', 'Duo', 'Squad']);
  // Clash Squad has no mode choice: the form hides the field.
  assert.equal(modesFor('free-fire', 'Clash Squad'), null);
  assert.deepEqual(
    modesFor('cod', 'Multiplayer'),
    ['Team Deathmatch', 'Domination', 'Search & Destroy', 'Hardpoint', 'Kill Confirmed'],
  );
  // Unknown match types keep every mode so custom entries work.
  assert.deepEqual(modesFor('bgmi', 'Room card'), ['Solo', 'Duo', 'Squad']);
  assert.equal(modesFor('unknown', 'Battle Royale'), null);
});
