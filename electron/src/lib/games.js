// Project-owned game catalog (renderer-safe, no IPC; main-safe, no
// node imports). The three entries mirror the loaded prompt packs
// (free-fire, cod, bgmi); the Call of Duty entry is deliberately the
// generic title, matching the pack's battle-royale-and-multiplayer
// wording — not a specific CoD release. Per-game suggestion lists
// drive the creation/Configure forms; stored metadata keeps free-text
// values so legacy projects always read back.
// Covered by electron/test/games.test.mjs.

export const GAMES = [
  {
    id: 'free-fire',
    name: 'Free Fire',
    shortName: 'Free Fire',
    matchTypes: ['Battle Royale', 'Clash Squad', 'Custom'],
    // Modes by match type; an empty list hides the mode field.
    modes: {
      'Battle Royale': ['Solo', 'Duo', 'Squad'],
      'Clash Squad': [],
      Custom: ['Solo', 'Duo', 'Squad'],
    },
    maps: ['Bermuda', 'Purgatory', 'Kalahari', 'Alpine', 'NeXTerra'],
    categories: ['Ranked', 'Casual', 'Tournament'],
  },
  {
    id: 'cod',
    name: 'Call of Duty',
    shortName: 'CoD',
    matchTypes: ['Battle Royale', 'Multiplayer'],
    modes: {
      'Battle Royale': ['Solo', 'Duo', 'Trio', 'Squad'],
      Multiplayer: ['Team Deathmatch', 'Domination', 'Search & Destroy', 'Hardpoint', 'Kill Confirmed'],
    },
    // No map suggestions: the catalog entry is title-generic, so the
    // map stays free text.
    maps: [],
    categories: ['Ranked', 'Casual', 'Tournament'],
  },
  {
    id: 'bgmi',
    name: 'Battlegrounds Mobile India',
    shortName: 'BGMI',
    matchTypes: ['Battle Royale', 'Custom Room'],
    modes: {
      'Battle Royale': ['Solo', 'Duo', 'Squad'],
      'Custom Room': ['Solo', 'Duo', 'Squad'],
    },
    maps: ['Erangel', 'Miramar', 'Sanhok', 'Vikendi'],
    categories: ['Ranked', 'Casual', 'Tournament'],
  },
];

export const SUPPORTED_GAME_IDS = GAMES.map((game) => game.id);

export const DEFAULT_GAME_ID = 'free-fire';

export function getGame(gameId) {
  return GAMES.find((game) => game.id === gameId) ?? null;
}

export function isSupportedGameId(gameId) {
  return SUPPORTED_GAME_IDS.includes(gameId);
}

export function gameDisplayName(gameId) {
  return getGame(gameId)?.name ?? 'Free Fire';
}

/**
 * Suggested modes for a game + match type, or null when the mode
 * field does not apply (the form hides it). Unknown match types
 * yield the union of that game's modes so custom entries keep
 * working.
 */
export function modesFor(gameId, matchType) {
  const game = getGame(gameId);
  if (!game) return null;
  if (matchType && Object.prototype.hasOwnProperty.call(game.modes, matchType)) {
    const modes = game.modes[matchType];
    return modes.length > 0 ? [...modes] : null;
  }
  const union = [...new Set(Object.values(game.modes).flat())];
  return union.length > 0 ? union : null;
}

export function matchTypesFor(gameId) {
  return [...(getGame(gameId)?.matchTypes ?? [])];
}

export function mapsFor(gameId) {
  return [...(getGame(gameId)?.maps ?? [])];
}

export function categoriesFor(gameId) {
  return [...(getGame(gameId)?.categories ?? [])];
}
