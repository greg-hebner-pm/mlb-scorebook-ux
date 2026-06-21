/**
 * main.js
 * Shared across index.html and pages/scorebook.html.
 * Responsible for loading gameData.json so every page works
 * from a single source of truth (per spec: no hardcoded game logic in HTML).
 */

const DATA_URL = (window.location.pathname.includes('/pages/'))
  ? '../data/gameData.json'
  : 'data/gameData.json';

async function loadGameData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load game data: ${res.status}`);
  return res.json();
}

// Expose globally for scorebook.js (kept intentionally simple at this stage —
// will move to a proper module pattern once the grid/modal logic is built out).
window.MLBScorebook = window.MLBScorebook || {};
window.MLBScorebook.loadGameData = loadGameData;
