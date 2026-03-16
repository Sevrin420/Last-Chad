// Builder & publish configuration for quest-builder.html and github-api.js.
// Centralizes values that were previously hardcoded across multiple files.
// Update this file when deploying to a new repo, branch, or worker.

var BUILDER_CONFIG = {
  // GitHub publishing target
  githubOwner: 'Sevrin420',
  githubRepo: 'Last-Chad',
  githubBranch: 'main',

  // Cloudflare Worker for quest session tracking & oracle signing
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
