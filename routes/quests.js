const express = require('express');
const router = express.Router();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

const REPO_OWNER = process.env.GITHUB_OWNER || 'Sevrin420';
const REPO_NAME = process.env.GITHUB_REPO || 'Last-Chad';
const VERCEL_REPO_OWNER = process.env.VERCEL_REPO_OWNER || 'Sevrin420';
const VERCEL_REPO_NAME = process.env.VERCEL_REPO_NAME || 'vercel-last-chad';
const VERCEL_URL = process.env.VERCEL_URL || 'https://vercel-last-chad-kovy4fnjn-sevs-projects-74385fd9.vercel.app';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

/**
 * Convert base64 image to buffer
 */
function base64ToBuffer(base64String) {
  const base64Data = base64String.split(',')[1] || base64String;
  return Buffer.from(base64Data, 'base64');
}

/**
 * Sanitize quest name for folder/file names
 */
function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate quest player HTML
 */
function generateQuestHTML(questData) {
  const questName = questData.name || 'Untitled Quest';
  const sanitized = sanitizeName(questName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${questName} | Last Chad</title>
  <link rel="stylesheet" href="../../styles.css">
  <link rel="stylesheet" href="../../nav.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      font-family: 'Press Start 2P', monospace;
      color: #f5e6c8;
      overflow-x: hidden;
    }

    .bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      background-color: #0a0a0f;
      background-image: radial-gradient(ellipse at 50% 0%, rgba(92, 68, 9, 0.15) 0%, transparent 60%);
    }

    .header {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: rgba(10, 10, 15, 0.9);
      border-bottom: 2px solid #3d2e0a;
      backdrop-filter: blur(8px);
    }

    .header-title {
      font-size: 0.9rem;
      color: #c9a84c;
      text-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
    }

    .main {
      position: relative;
      z-index: 1;
      margin-top: 80px;
      padding: 24px;
      max-width: 900px;
      margin-left: auto;
      margin-right: auto;
      margin-bottom: 40px;
    }

    .quest-title {
      font-size: 0.7rem;
      color: #7ee8d4;
      margin-bottom: 20px;
      text-shadow: 0 0 8px rgba(126, 232, 212, 0.3);
      text-align: center;
    }

    .section-container {
      background: rgba(30, 20, 10, 0.8);
      border: 2px solid #7ee8d4;
      border-radius: 4px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 0 12px rgba(126, 232, 212, 0.15);
    }

    .section-name {
      font-size: 0.55rem;
      color: #c9a84c;
      margin-bottom: 16px;
      text-shadow: 0 0 4px rgba(201, 168, 76, 0.2);
    }

    .section-image {
      width: 100%;
      max-width: 500px;
      height: auto;
      border: 1px solid #7ee8d4;
      border-radius: 4px;
      margin-bottom: 16px;
      display: none;
    }

    .section-image.visible {
      display: block;
    }

    .dialogue {
      font-size: 0.35rem;
      color: #f5e6c8;
      line-height: 1.6;
      margin-bottom: 20px;
      text-shadow: 0 0 4px rgba(0, 0, 0, 0.3);
    }

    .choices {
      display: grid;
      gap: 12px;
    }

    .choice-btn {
      background: linear-gradient(135deg, rgba(201, 168, 76, 0.3) 0%, rgba(201, 168, 76, 0.1) 100%);
      border: 2px solid #c9a84c;
      color: #c9a84c;
      padding: 16px;
      font-size: 0.35rem;
      font-family: 'Press Start 2P', monospace;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.3s;
      text-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
    }

    .choice-btn:hover {
      background: linear-gradient(135deg, rgba(201, 168, 76, 0.4) 0%, rgba(201, 168, 76, 0.2) 100%);
      box-shadow: 0 0 16px rgba(201, 168, 76, 0.3);
      transform: translateY(-2px);
    }

    .choice-btn:active {
      transform: translateY(0);
    }

    .double-choices {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .loading {
      text-align: center;
      font-size: 0.35rem;
      color: #7ee8d4;
      padding: 40px;
    }

    .back-btn {
      background: rgba(126, 232, 212, 0.2);
      border: 2px solid #7ee8d4;
      color: #7ee8d4;
      padding: 12px 24px;
      font-size: 0.3rem;
      font-family: 'Press Start 2P', monospace;
      cursor: pointer;
      border-radius: 4px;
      margin-bottom: 20px;
      transition: all 0.3s;
    }

    .back-btn:hover {
      background: rgba(126, 232, 212, 0.3);
      box-shadow: 0 0 12px rgba(126, 232, 212, 0.3);
    }

    @media (max-width: 768px) {
      .double-choices {
        grid-template-columns: 1fr;
      }
      .main {
        padding: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="bg"></div>

  <div class="header">
    <div class="header-title">⚔️ ${questName}</div>
    <div class="nav-menu" id="navMenu"></div>
  </div>

  <div class="main">
    <button class="back-btn" onclick="window.history.back()">← Back</button>
    <h1 class="quest-title">${questName}</h1>
    <div id="questContainer" class="loading">Loading quest...</div>
  </div>

  <script src="../../nav.js"><\/script>
  <script>
    const questData = ${JSON.stringify(questData)};
    const sectionMap = {};
    let currentSectionId = null;

    // Build section map
    questData.sections.forEach(section => {
      sectionMap[section.id] = section;
    });

    function findNextSection(section, choiceType = null) {
      if (!section) return null;

      if (section.selectedChoice === 'single') {
        return sectionMap[section.nextSectionId] || null;
      } else if (section.selectedChoice === 'double' && choiceType) {
        const nextId = choiceType === 1 ? section.choice1NextSectionId : section.choice2NextSectionId;
        return sectionMap[nextId] || null;
      } else if (section.selectedChoice === 'dice' && choiceType) {
        const nextId = choiceType === 'pass' ? section.passNextSectionId : section.failNextSectionId;
        return sectionMap[nextId] || null;
      }

      return null;
    }

    function displaySection(sectionId = null) {
      if (!sectionId && questData.sections.length > 0) {
        sectionId = questData.sections[0].id;
      }

      const section = sectionMap[sectionId];
      if (!section) {
        document.getElementById('questContainer').innerHTML = '<div class="loading">Quest ended. Thanks for playing!</div>';
        return;
      }

      currentSectionId = sectionId;

      let html = \`
        <div class="section-container">
          <div class="section-name">\${section.name}</div>
      \`;

      if (section.photo) {
        html += \`<img src="images/\${section.id}.png" alt="\${section.name}" class="section-image visible">\`;
      }

      html += \`
          <div class="dialogue">\${section.dialogue || 'No dialogue...'}</div>
      \`;

      if (section.selectedChoice === 'single') {
        const nextSection = findNextSection(section);
        html += \`
          <div class="choices">
            <button class="choice-btn" onclick="displaySection(\${nextSection ? nextSection.id : 'null'})">
              \${section.buttonName || 'Continue'}
            </button>
          </div>
        \`;
      } else if (section.selectedChoice === 'double') {
        const next1 = findNextSection(section, 1);
        const next2 = findNextSection(section, 2);
        html += \`
          <div class="choices double-choices">
            <button class="choice-btn" onclick="displaySection(\${next1 ? next1.id : 'null'})">
              \${section.button1Name || 'Choice A'}
            </button>
            <button class="choice-btn" onclick="displaySection(\${next2 ? next2.id : 'null'})">
              \${section.button2Name || 'Choice B'}
            </button>
          </div>
        \`;
      } else if (section.selectedChoice === 'dice') {
        html += \`
          <div class="choices">
            <button class="choice-btn" onclick="handleDiceRoll('pass')" style="margin-bottom: 12px;">
              🎲 Roll Dice
            </button>
            <p style="text-align: center; font-size: 0.25rem; color: #a0963d; margin-top: 16px;">
              Need 6 + 5 + 4 to pass!
            </p>
          </div>
        \`;
      }

      html += '</div>';
      document.getElementById('questContainer').innerHTML = html;
    }

    function handleDiceRoll(outcome) {
      const section = sectionMap[currentSectionId];
      const nextSection = findNextSection(section, outcome);

      // Simple dice roll animation
      let rolls = 0;
      const interval = setInterval(() => {
        const dice = Math.floor(Math.random() * 6) + 1;
        document.querySelector('.choice-btn').textContent = '🎲 ' + dice;
        rolls++;
        if (rolls > 10) {
          clearInterval(interval);
          displaySection(nextSection ? nextSection.id : null);
        }
      }, 100);
    }

    // Load first section
    displaySection();
  <\/script>
</body>
</html>`;
}

/**
 * POST /api/publish-quest
 * Publish a quest to GitHub
 */
router.post('/publish-quest', async (req, res) => {
  try {
    const { questName, sections } = req.body;

    if (!questName || !sections || sections.length === 0) {
      return res.status(400).json({ error: 'Quest name and sections required' });
    }

    const sanitized = sanitizeName(questName);
    const questPath = `quests/${sanitized}`;
    const imagesPath = `${questPath}/images`;

    console.log(`📝 Publishing quest: ${questName} → ${questPath}`);

    // Prepare files to commit
    const files = [];

    // 1. Create quest HTML player
    const questHTML = generateQuestHTML({ name: questName, sections });
    files.push({
      path: `${questPath}/index.html`,
      content: questHTML,
      message: `Quest HTML player`
    });

    // 2. Save quest data as JSON
    files.push({
      path: `${questPath}/data.json`,
      content: JSON.stringify({ name: questName, sections }, null, 2),
      message: `Quest data`
    });

    // 3. Process and save images
    for (const section of sections) {
      if (section.photo) {
        const imageBuffer = base64ToBuffer(section.photo);
        files.push({
          path: `${imagesPath}/${section.id}.png`,
          content: imageBuffer.toString('base64'),
          message: `Section image for ${section.name}`,
          isBase64: true
        });
      }

      if (section.diceImage) {
        const diceBuffer = base64ToBuffer(section.diceImage);
        files.push({
          path: `${imagesPath}/dice-${section.id}.png`,
          content: diceBuffer.toString('base64'),
          message: `Dice image for ${section.name}`,
          isBase64: true
        });
      }
    }

    // Get current repo to find the latest commit
    const branchData = await octokit.repos.getBranch({
      owner: VERCEL_REPO_OWNER,
      repo: VERCEL_REPO_NAME,
      branch: BRANCH
    });

    const latestCommitSha = branchData.data.commit.sha;

    // Get the tree of the latest commit
    const treeData = await octokit.git.getTree({
      owner: VERCEL_REPO_OWNER,
      repo: VERCEL_REPO_NAME,
      tree_sha: latestCommitSha,
      recursive: true
    });

    // Create new tree with all files
    const treeItems = treeData.data.tree.map(item => ({
      path: item.path,
      mode: item.mode,
      type: item.type,
      sha: item.sha
    }));

    // Add new files to tree
    for (const file of files) {
      const blob = await octokit.git.createBlob({
        owner: VERCEL_REPO_OWNER,
        repo: VERCEL_REPO_NAME,
        content: file.content,
        encoding: file.isBase64 ? 'base64' : 'utf-8'
      });

      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.data.sha
      });
    }

    // Create new tree
    const newTree = await octokit.git.createTree({
      owner: VERCEL_REPO_OWNER,
      repo: VERCEL_REPO_NAME,
      tree: treeItems,
      base_tree: latestCommitSha
    });

    // Create commit
    const commit = await octokit.git.createCommit({
      owner: VERCEL_REPO_OWNER,
      repo: VERCEL_REPO_NAME,
      message: `Add quest: ${questName}\n\nPublished from Quest Builder`,
      tree: newTree.data.sha,
      parents: [latestCommitSha]
    });

    // Update branch reference
    await octokit.git.updateRef({
      owner: VERCEL_REPO_OWNER,
      repo: VERCEL_REPO_NAME,
      ref: `heads/${BRANCH}`,
      sha: commit.data.sha
    });

    const questUrl = `${VERCEL_URL}/quests/${sanitized}/`;

    console.log(`✅ Quest published successfully!`);

    res.json({
      success: true,
      message: `Quest "${questName}" published successfully!`,
      questUrl,
      questPath: `quests/${sanitized}`,
      commit: commit.data.sha
    });

  } catch (error) {
    console.error('Error publishing quest:', error);
    res.status(500).json({
      error: 'Failed to publish quest',
      details: error.message
    });
  }
});

module.exports = router;
