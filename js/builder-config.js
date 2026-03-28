// ══════════════════════════════════════════════════════════════════════
// builder-config.js — Settings for quest-builder.html & github-api.js
// ══════════════════════════════════════════════════════════════════════
// Contains builder-specific values (GitHub target, known items) that
// are NOT needed by any other page.
//
// workerUrl is also stored here for the builder's publish flow (it gets
// baked into generated quest HTML).  The canonical copy lives in
// js/config.js — keep them in sync.
// ══════════════════════════════════════════════════════════════════════

var BUILDER_CONFIG = {
  // GitHub publishing target
  githubOwner: 'Sevrin420',
  githubRepo: 'Last-Chad',
  githubBranch: 'main',

  // Cloudflare Worker URL (mirror of WORKER_URL in config.js)
  workerUrl: 'https://last-chad-runner.severin20.workers.dev',

  // Quest builder limits
  maxCellsPerSection: 50,   // matches worker hard cap per section

  // Known items — keyed by on-chain item ID from LastChadItems.sol
  // Used in: quest-builder dropdown, generated quest knownItems map, HUD badges
  knownItems: {
    '1': {
      name: "Cindy's Code",
      image: 'https://lastchad.xyz/assets/docs_lobby/lobbybrochure.jpg',
      description: "A flash drive containing Cindy's proprietary code. Whoever carries it feels their mind sharpen.",
      modifiers: { str: 0, int: 1, dex: 0, cha: 0 }
    }
  }
};
