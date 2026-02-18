/**
 * GitHub API utilities for publishing quests
 * Uses personal access token for authentication
 */

class GitHubAPI {
  constructor(token, owner, repo, branch = 'main') {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.baseUrl = 'https://api.github.com';

    // Validate token format
    if (!token || !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      console.warn('⚠️ GitHub token format may be invalid');
    }
  }

  async request(method, path, data = null) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        let error;
        try {
          error = await response.json();
        } catch (e) {
          error = { message: response.statusText };
        }
        const errorMsg = error.message || error.error || `GitHub API error: ${response.status}`;
        console.error(`❌ API Error ${response.status} (${method} ${path}):`, errorMsg);
        throw new Error(errorMsg);
      }

      return response.json();
    } catch (err) {
      // If it's already a GitHub API error, rethrow it
      if (err.message.includes('API Error') || err.message.includes('Not Found')) {
        throw err;
      }
      // Otherwise, it's a network error
      console.error(`❌ Network Error (${method} ${path}):`, err.message);
      throw new Error(`Network error: ${err.message}`);
    }
  }

  async getBranchRef() {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`);
  }

  async getCommit(sha) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/git/commits/${sha}`);
  }

  async getTree(sha, recursive = false) {
    const url = `/repos/${this.owner}/${this.repo}/git/trees/${sha}${recursive ? '?recursive=true' : ''}`;
    return this.request('GET', url);
  }

  async createBlob(content, encoding = 'utf-8') {
    return this.request('POST', `/repos/${this.owner}/${this.repo}/git/blobs`, {
      content,
      encoding
    });
  }

  async createTree(tree, baseTree) {
    return this.request('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      tree,
      base_tree: baseTree
    });
  }

  async createCommit(message, tree, parents) {
    return this.request('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      message,
      tree,
      parents
    });
  }

  async updateRef(sha) {
    return this.request('PATCH', `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`, {
      sha
    });
  }

  async publishQuest(questName, sections, onProgress = null) {
    // Count images up-front so we can report accurate progress
    let imageCount = 0;
    for (const section of sections) {
      if (section.photo) imageCount++;
      if (section.diceImage) imageCount++;
    }
    // Steps: branch ref, commit tree, html blob, data blob, [images...], tree, commit, update ref
    const totalSteps = 4 + imageCount + 3;
    let step = 0;

    const progress = (msg) => {
      step++;
      if (onProgress) onProgress(step, totalSteps, msg);
      console.log(`[${step}/${totalSteps}] ${msg}`);
    };

    try {
      // Sanitize quest name for path
      const sanitized = questName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

      const questPath = `quests/${sanitized}`;
      const imagesPath = `${questPath}/images`;

      console.log(`📝 Publishing quest: ${questName}`);
      console.log(`🔗 Repository: ${this.owner}/${this.repo}`);
      console.log(`🌿 Branch: ${this.branch}`);

      // Get current branch reference
      progress('Fetching branch reference...');
      const branchRef = await this.getBranchRef();
      const latestCommitSha = branchRef.object.sha;
      console.log(`✓ Branch reference found, commit: ${latestCommitSha.substring(0, 7)}`);

      // Get the commit tree
      progress('Fetching commit tree...');
      const commit = await this.getCommit(latestCommitSha);
      const treeData = await this.getTree(commit.tree.sha, true);
      console.log(`✓ Tree fetched with ${treeData.tree.length} existing items`);

      // Prepare tree items
      const treeItems = treeData.tree.map(item => ({
        path: item.path,
        mode: item.mode,
        type: item.type,
        sha: item.sha
      }));

      // Generate quest HTML
      progress('Generating quest HTML...');
      const questHTML = generateQuestHTML(questName, sections);
      const htmlBlob = await this.createBlob(questHTML, 'utf-8');
      console.log(`✓ Quest HTML blob created`);
      treeItems.push({
        path: `${questPath}/index.html`,
        mode: '100644',
        type: 'blob',
        sha: htmlBlob.sha
      });

      // Add quest data JSON (strip image data to keep it lean)
      progress('Saving quest data...');
      const cleanSections = sections.map(({ photo, diceImage, ...rest }) => rest);
      const questDataBlob = await this.createBlob(
        JSON.stringify({ name: questName, sections: cleanSections }, null, 2),
        'utf-8'
      );
      treeItems.push({
        path: `${questPath}/data.json`,
        mode: '100644',
        type: 'blob',
        sha: questDataBlob.sha
      });

      // Process and add images
      let uploadedImages = 0;
      for (const section of sections) {
        if (section.photo) {
          const imageParts = section.photo.split(',');
          const imageData = imageParts.length > 1 ? imageParts[1] : imageParts[0];
          if (!imageData) {
            console.warn(`⚠️ Invalid photo data for section ${section.id}`);
          } else {
            progress(`Uploading image for section "${section.name}"...`);
            const imageBlob = await this.createBlob(imageData, 'base64');
            treeItems.push({
              path: `${imagesPath}/${section.id}.png`,
              mode: '100644',
              type: 'blob',
              sha: imageBlob.sha
            });
            uploadedImages++;
          }
        }

        if (section.diceImage) {
          const diceParts = section.diceImage.split(',');
          const diceData = diceParts.length > 1 ? diceParts[1] : diceParts[0];
          if (!diceData) {
            console.warn(`⚠️ Invalid dice image data for section ${section.id}`);
          } else {
            progress(`Uploading dice image for section "${section.name}"...`);
            const diceBlob = await this.createBlob(diceData, 'base64');
            treeItems.push({
              path: `${imagesPath}/dice-${section.id}.png`,
              mode: '100644',
              type: 'blob',
              sha: diceBlob.sha
            });
            uploadedImages++;
          }
        }
      }
      console.log(`✓ Uploaded ${uploadedImages} images`);

      // Create new tree
      progress(`Building file tree (${treeItems.length} files)...`);
      const newTree = await this.createTree(treeItems, commit.tree.sha);
      console.log(`✓ Tree created: ${newTree.sha.substring(0, 7)}`);

      // Create commit
      progress('Creating commit...');
      const newCommit = await this.createCommit(
        `Add quest: ${questName}\n\nPublished from Quest Builder`,
        newTree.sha,
        [latestCommitSha]
      );
      console.log(`✓ Commit created: ${newCommit.sha.substring(0, 7)}`);

      // Update branch reference
      progress('Updating branch...');
      await this.updateRef(newCommit.sha);
      console.log(`✓ Branch reference updated`);

      console.log(`✅ Quest published successfully!`);

      return {
        success: true,
        message: `Quest "${questName}" published successfully!`,
        questUrl: `https://lastchad.xyz/quests/${sanitized}/`,
        questPath: `quests/${sanitized}`
      };
    } catch (error) {
      console.error('❌ Error publishing quest:', error);
      // Add more context to the error
      if (error.message.includes('Not Found')) {
        console.error('📍 Not Found (404) - Check if:');
        console.error('   - Repository exists at https://github.com/' + this.owner + '/' + this.repo);
        console.error('   - Branch "' + this.branch + '" exists');
        console.error('   - GitHub token has valid "repo" scope');
      }
      throw error;
    }
  }
}

/**
 * Generate quest player HTML — matches quest.html visual format
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function generateQuestHTML(questName, sections) {
  const sanitized = questName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Detect if any section uses dice
  const hasDice = sections.some(s => s.selectedChoice === 'dice');

  // Build dice outcome map for embedded JS
  const diceOutcomes = {};
  sections.forEach(s => {
    if (s.selectedChoice === 'dice') {
      diceOutcomes[s.id] = {
        passNextId: s.passNextSectionId || null,
        failNextId: s.failNextSectionId || null,
        statBonus: s.statBonus || null,
        difficulty: s.difficulty !== undefined ? s.difficulty : 8
      };
    }
  });
  const diceSectionIds = sections.filter(s => s.selectedChoice === 'dice').map(s => s.id);

  // Format dialogue text: split on newlines into <p> tags
  function formatDialogue(text) {
    if (!text) return '<p>...</p>';
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) return '<p>...</p>';
    return lines.map(l => `<p>${escapeHtml(l)}</p>`).join('\n          ');
  }

  // Generate HTML for all panels (one per section)
  const panelsHtml = sections.map((section, idx) => {
    const sid = section.id;
    const isFirst = idx === 0;
    const sectionName = escapeHtml(section.name || `Section ${idx + 1}`);
    const dialogueHtml = formatDialogue(section.dialogue);
    const imageHtml = section.photo
      ? `<img src="images/${sid}.png" alt="${sectionName}" class="section-img">`
      : '';

    let actionHtml = '';

    if (section.selectedChoice === 'single') {
      const nextId = section.nextSectionId || null;
      actionHtml = `
        <button class="action-btn" onclick="goToSection(${nextId})">
          ${escapeHtml(section.buttonName || 'CONTINUE')}
        </button>`;

    } else if (section.selectedChoice === 'double') {
      const next1 = section.choice1NextSectionId || null;
      const next2 = section.choice2NextSectionId || null;
      const btn1 = escapeHtml(section.button1Name || 'Choice A');
      const btn2 = escapeHtml(section.button2Name || 'Choice B');
      actionHtml = `
        <div class="choices">
          <button class="choice-btn" onclick="goToSection(${next1})">
            <span class="choice-label">[ ${btn1} ]</span>
          </button>
          <button class="choice-btn" onclick="goToSection(${next2})">
            <span class="choice-label">[ ${btn2} ]</span>
          </button>
        </div>`;

    } else if (section.selectedChoice === 'dice') {
      // Full Ship-Captain-Crew dice section (matching quest.html)
      const statLabelMap = {
        strength: 'STRENGTH', intelligence: 'INTELLIGENCE',
        dexterity: 'DEXTERITY', charisma: 'CHARISMA'
      };
      const statLabel = statLabelMap[section.statBonus] || 'STAT';
      const difficulty = section.difficulty !== undefined ? section.difficulty : 8;

      const diceColsHtml = [0,1,2,3,4].map(i => `
              <div class="dice-col">
                <div class="dice-box" id="die${i}_${sid}"><div class="dice-face" id="face${i}_${sid}"></div></div>
                <button class="keep-btn" id="keep${i}_${sid}" disabled>LOCK</button>
              </div>`).join('');

      const diceImgHtml = section.diceImage
        ? `<img src="images/dice-${sid}.png" alt="Dice visual" class="section-img">`
        : '';

      actionHtml = `
        <div class="dice-section">
          ${diceImgHtml}
          <div class="dice-meta-tag">${statLabel} BONUS +0 &nbsp;&nbsp; DIFFICULTY: ${difficulty}</div>
          <div class="dice-row">${diceColsHtml}
          </div>
          <div class="roll-section">
            <button class="roll-btn" id="rollBtn_${sid}" onclick="rollDice(${sid})">ROLL</button>
            <div class="rolls-left" id="rollsLeft_${sid}">3 ROLLS LEFT</div>
          </div>
          <div class="score-box" id="scoreBox_${sid}">
            <div class="checklist">
              <div class="check-item" id="check6_${sid}">
                <div class="check-box"><span class="check-mark">✓</span></div>
                <span>6 = SHIP</span>
              </div>
              <div class="check-item" id="check5_${sid}">
                <div class="check-box"><span class="check-mark">✓</span></div>
                <span>5 = CAPTAIN</span>
              </div>
              <div class="check-item" id="check4_${sid}">
                <div class="check-box"><span class="check-mark">✓</span></div>
                <span>4 = MATE</span>
              </div>
            </div>
            <div class="score-right">
              <div class="score-label" id="scoreLabel_${sid}">ROLL THE DICE</div>
              <div class="score-value" id="scoreValue_${sid}">-</div>
            </div>
          </div>
          <div class="continue-wrap" id="continueWrap_${sid}">
            <div class="dice-result-text" id="diceResultText_${sid}"></div>
            <button class="action-btn" id="diceActionBtn_${sid}">CONTINUE</button>
          </div>
        </div>`;

    } else {
      // Fallback: terminal section
      actionHtml = `<button class="action-btn" onclick="goToSection(null)">CONTINUE</button>`;
    }

    return `
      <!-- ${sectionName} -->
      <div class="panel${isFirst ? ' active' : ''}" id="panel-${sid}">
        <div class="mission-tag">${sectionName}</div>
        ${imageHtml}
        <div class="narrative">
          ${dialogueHtml}
        </div>
        ${actionHtml}
      </div>`;
  }).join('\n');

  // Quest complete panel
  const completePanelHtml = `
      <!-- Quest Complete -->
      <div class="panel" id="panel-complete">
        <div class="mission-tag">QUEST COMPLETE</div>
        <div class="narrative">
          <p>You have reached the end of <span class="highlight">${escapeHtml(questName)}</span>.</p>
          ${hasDice ? '<p>Your crew held strong through every trial.</p>' : '<p>Well played, Chad.</p>'}
        </div>
        ${hasDice ? `
        <div class="score-breakdown">
          <div class="breakdown-title">AFTER ACTION REPORT</div>
          <div class="breakdown-row total">
            <span class="breakdown-label">TOTAL CREW SCORE</span>
            <span class="breakdown-val" id="finalScore">0</span>
          </div>
        </div>` : ''}
        <button class="action-btn" onclick="window.history.back()">RETURN</button>
      </div>`;

  const diceOutcomesJson = JSON.stringify(diceOutcomes);
  const diceInitJs = diceSectionIds.map(id => `    getDiceState(${id});`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(questName)} | Last Chad</title>
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

    /* Background — checkerboard wood texture matching quest.html */
    .bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      background-color: #3b2a14;
      background-image:
        linear-gradient(45deg, #4a3520 25%, transparent 25%),
        linear-gradient(-45deg, #4a3520 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #2e1e0e 75%),
        linear-gradient(-45deg, transparent 75%, #2e1e0e 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      image-rendering: pixelated;
    }
    .bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at 50% 30%, rgba(90, 65, 30, 0.4) 0%, transparent 70%),
        linear-gradient(180deg, rgba(30, 20, 10, 0.3) 0%, rgba(30, 20, 10, 0.6) 100%);
    }

    .header {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: rgba(30, 20, 10, 0.9);
      border-bottom: 2px solid #5c4409;
      backdrop-filter: blur(8px);
    }
    .chad-name {
      font-size: 0.55rem;
      color: #c9a84c;
      text-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
    }

    .main {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 90px 16px 60px;
    }

    .section-img {
      width: 100%;
      max-width: 500px;
      height: auto;
      border: 2px solid #5c4409;
      border-radius: 4px;
      margin-bottom: 20px;
      display: block;
    }

    /* Crew score tracker */
    .crew-tracker {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(20, 14, 6, 0.7);
      border: 2px solid #3d2e0a;
      border-radius: 4px;
      padding: 10px 16px;
      margin-bottom: 20px;
      width: 100%;
      max-width: 560px;
    }
    .crew-tracker-label { font-size: 0.4rem; color: #8a7a5a; }
    .crew-tracker-value { font-size: 0.8rem; color: #c9a84c; text-shadow: 0 0 8px rgba(201, 168, 76, 0.4); }

    /* Quest panel */
    .quest-panel {
      width: 100%;
      max-width: 560px;
      background: rgba(10, 8, 4, 0.85);
      border: 3px solid #5c4409;
      border-radius: 6px;
      padding: 28px 24px;
      box-shadow: inset 0 0 30px rgba(0, 0, 0, 0.6), 0 4px 20px rgba(0, 0, 0, 0.5);
    }

    .panel { display: none; }
    .panel.active { display: block; }

    .mission-tag {
      font-size: 0.45rem;
      color: #e53935;
      letter-spacing: 0.15em;
      margin-bottom: 16px;
    }

    .narrative {
      font-size: clamp(0.5rem, 1.8vw, 0.65rem);
      line-height: 2.2;
      color: #f5e6c8;
      margin-bottom: 24px;
    }
    .narrative p + p { margin-top: 14px; }
    .highlight { color: #c9a84c; }

    /* Choice buttons */
    .choices { display: flex; flex-direction: column; gap: 12px; }

    .choice-btn {
      padding: 16px 20px;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.45rem, 1.8vw, 0.6rem);
      color: #f5e6c8;
      background: rgba(30, 22, 8, 0.8);
      border: 3px solid #5c4409;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
      line-height: 1.8;
      transition: all 0.15s;
      touch-action: manipulation;
      box-shadow: inset -2px -2px 0 #1a1200, inset 2px 2px 0 #3d2e0a, 2px 2px 0 #000;
    }
    .choice-btn:hover { border-color: #c9a84c; color: #c9a84c; background: rgba(50, 36, 10, 0.85); }
    .choice-btn:active { transform: translateY(2px); box-shadow: inset -1px -1px 0 #1a1200, inset 1px 1px 0 #3d2e0a, 1px 1px 0 #000; }
    .choice-label { color: #c9a84c; display: block; margin-bottom: 6px; }
    .choice-btn:hover .choice-label { color: #ffe082; }

    /* Primary action button */
    .action-btn {
      width: 100%;
      padding: 16px 40px;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.65rem, 2.5vw, 0.85rem);
      color: #fff;
      background: linear-gradient(180deg, #c9a84c 0%, #8b6914 50%, #5c4409 100%);
      border: 3px solid #d4a017;
      border-radius: 6px;
      cursor: pointer;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
      box-shadow: inset 0 2px 0 rgba(255, 220, 120, 0.4), inset 0 -2px 0 rgba(0, 0, 0, 0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0, 0, 0, 0.5);
      transition: all 0.2s;
      touch-action: manipulation;
      animation: glow 2s ease-in-out infinite;
    }
    .action-btn:hover { animation: none; background: linear-gradient(180deg, #dabb5e 0%, #a07d1e 50%, #6b5010 100%); border-color: #f5e6c8; }
    .action-btn:active { transform: translateY(3px); }

    @keyframes glow {
      0%, 100% { box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5), 0 0 15px rgba(139,105,20,0.2); }
      50%       { box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5), 0 0 28px rgba(201,168,76,0.4); }
    }

    /* Dice stat/difficulty header */
    .dice-meta-tag {
      font-size: 0.42rem;
      color: #e53935;
      letter-spacing: 0.1em;
      margin-bottom: 14px;
      text-align: center;
      line-height: 2;
    }

    /* Dice system */
    .dice-section { width: 100%; margin-top: 8px; }
    .dice-row { display: flex; justify-content: center; gap: 8px; }
    .dice-col { display: flex; flex-direction: column; align-items: center; gap: 8px; }

    .dice-box {
      width: clamp(48px, 13vw, 72px);
      height: clamp(48px, 13vw, 72px);
      background: rgba(20, 14, 6, 0.9);
      border: 3px solid #5c4409;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
      box-shadow: inset 0 0 15px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4);
    }
    .dice-box.rolling { border-color: #c9a84c; box-shadow: inset 0 0 15px rgba(0,0,0,0.4), 0 0 12px rgba(201,168,76,0.3); }
    .dice-box.kept    { border-color: #4caf50; box-shadow: inset 0 0 10px rgba(0,0,0,0.3), 0 0 10px rgba(76,175,80,0.25); }
    .dice-box.settled { border-color: #c9a84c; }

    .dice-face {
      width: 100%; height: 100%;
      display: grid;
      grid-template-rows: 1fr 1fr 1fr;
      grid-template-columns: 1fr 1fr 1fr;
      padding: 15%;
      gap: 2px;
    }
    .dice-face .dot {
      width: 100%;
      aspect-ratio: 1;
      background: #c9a84c;
      border-radius: 50%;
      box-shadow: 0 0 4px rgba(201,168,76,0.5);
    }
    .dice-box.kept .dice-face .dot { background: #4caf50; box-shadow: 0 0 4px rgba(76,175,80,0.5); }
    .dot { visibility: hidden; }

    .keep-btn {
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.28rem, 1.2vw, 0.38rem);
      padding: 6px 0;
      width: clamp(48px, 13vw, 72px);
      color: #8a7a5a;
      background: rgba(61, 46, 10, 0.3);
      border: 3px solid #3d2e0a;
      border-radius: 0;
      cursor: pointer;
      transition: all 0.15s;
      touch-action: manipulation;
      box-shadow: inset -2px -2px 0 #1a1200, inset 2px 2px 0 #5c4409, 2px 2px 0 #000;
    }
    .keep-btn:hover { border-color: #5c4409; color: #c9a84c; }
    .keep-btn.active { border-color: #4caf50; color: #4caf50; background: rgba(76,175,80,0.1); box-shadow: inset -2px -2px 0 #2e7d32, inset 2px 2px 0 #66bb6a, 2px 2px 0 #000; }
    .keep-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    .roll-section { margin-top: 18px; text-align: center; }

    .roll-btn {
      padding: 14px 40px;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.65rem, 2.5vw, 0.85rem);
      color: #fff;
      background: linear-gradient(180deg, #c9a84c 0%, #8b6914 50%, #5c4409 100%);
      border: 3px solid #d4a017;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
      box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5);
      touch-action: manipulation;
      animation: roll-glow 2s ease-in-out infinite;
    }
    .roll-btn:hover { animation: none; background: linear-gradient(180deg, #dabb5e 0%, #a07d1e 50%, #6b5010 100%); border-color: #f5e6c8; }
    .roll-btn:active { transform: translateY(3px); }
    .roll-btn:disabled { opacity: 0.4; cursor: not-allowed; animation: none; }

    @keyframes roll-glow {
      0%, 100% { box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5), 0 0 15px rgba(139,105,20,0.2); }
      50%       { box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5), 0 0 28px rgba(201,168,76,0.4); }
    }

    .rolls-left { margin-top: 10px; font-size: 0.4rem; color: #8a7a5a; }

    .score-box {
      display: flex;
      margin-top: 18px;
      padding: 16px 20px;
      background: #0a0a0f;
      border: 3px solid #5c4409;
      border-radius: 6px;
      box-shadow: inset 0 0 20px rgba(0,0,0,0.8), 0 4px 16px rgba(0,0,0,0.5);
      gap: 16px;
      align-items: flex-start;
    }
    .checklist { display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; }
    .check-item { display: flex; align-items: center; gap: 10px; font-size: clamp(0.42rem, 1.8vw, 0.55rem); color: #e53935; transition: color 0.3s; }
    .check-item.checked { color: #4caf50; }
    .check-box { width: 20px; height: 20px; border: 3px solid #e53935; border-radius: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: border-color 0.3s, background 0.3s; }
    .check-item.checked .check-box { border-color: #4caf50; background: rgba(76,175,80,0.15); }
    .check-mark { display: none; color: #4caf50; font-size: 1.2rem; line-height: 0; margin-top: -2px; }
    .check-item.checked .check-mark { display: block; }
    .score-right { flex: 1; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 70px; }
    .score-label { font-size: clamp(0.45rem, 2vw, 0.6rem); color: #8a7a5a; margin-bottom: 8px; line-height: 2; }
    .score-value { font-size: clamp(1.6rem, 6vw, 2.6rem); color: #c9a84c; text-shadow: 0 0 12px rgba(201,168,76,0.5); }
    .score-box.no-score .score-label { color: #e53935; }
    .score-box.no-score .score-value { color: #e53935; text-shadow: 0 0 12px rgba(229,57,53,0.4); }
    .score-box.scored .score-label { color: #8a7a5a; }
    .score-box.scored .score-value { color: #c9a84c; }

    .continue-wrap { margin-top: 20px; display: none; }
    .continue-wrap.show { display: block; }
    .dice-result-text { font-size: clamp(0.45rem, 1.8vw, 0.6rem); line-height: 2.2; color: #f5e6c8; margin-bottom: 16px; }
    .dice-result-text .highlight { color: #c9a84c; }

    /* Score breakdown (quest complete panel) */
    .score-breakdown {
      background: rgba(20, 14, 6, 0.8);
      border: 2px solid #3d2e0a;
      border-radius: 4px;
      padding: 18px 20px;
      margin-bottom: 24px;
    }
    .breakdown-title { font-size: 0.42rem; color: #8a7a5a; letter-spacing: 0.12em; margin-bottom: 16px; }
    .breakdown-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(61, 46, 10, 0.4); }
    .breakdown-row:last-child { border-bottom: none; }
    .breakdown-label { font-size: clamp(0.38rem, 1.5vw, 0.48rem); color: #8a7a5a; }
    .breakdown-val { font-size: clamp(0.5rem, 2vw, 0.65rem); color: #c9a84c; }
    .breakdown-row.total .breakdown-label { color: #f5e6c8; font-size: clamp(0.42rem, 1.8vw, 0.55rem); }
    .breakdown-row.total .breakdown-val { font-size: clamp(0.8rem, 3vw, 1.1rem); color: #c9a84c; text-shadow: 0 0 10px rgba(201,168,76,0.5); }

    @media (max-width: 480px) {
      .header { padding: 12px 16px; }
      .quest-panel { padding: 20px 16px; }
      .dice-row { gap: 5px; }
    }
  </style>
</head>
<body>
  <div class="bg"></div>

  <header class="header">
    <div id="nav-placeholder"></div>
    <span class="chad-name">${escapeHtml(questName)}</span>
  </header>

  <main class="main">
    ${hasDice ? `
    <div class="crew-tracker" id="crewTracker">
      <span class="crew-tracker-label">CREW SCORE</span>
      <span class="crew-tracker-value" id="crewScoreDisplay">0</span>
    </div>` : ''}

    <div class="quest-panel">
${panelsHtml}
${completePanelHtml}
    </div>
  </main>

  <script src="../../nav.js"><\/script>
  <script>
    var crewScore = 0;
    var diceOutcomes = ${diceOutcomesJson};

    var dotLayouts = {
      1: [0,0,0, 0,1,0, 0,0,0],
      2: [0,0,1, 0,0,0, 1,0,0],
      3: [0,0,1, 0,1,0, 1,0,0],
      4: [1,0,1, 0,0,0, 1,0,1],
      5: [1,0,1, 0,1,0, 1,0,1],
      6: [1,0,1, 1,0,1, 1,0,1]
    };
    // Strip image data from sections — images are served as files in /images/
    const questData = ${
      JSON.stringify({
        name: questName,
        sections: sections.map(({ photo, diceImage, ...rest }) => ({ ...rest, hasPhoto: !!photo, hasDiceImage: !!diceImage }))
      }).replace(/<\//g, '<\\/')
    };
    const sectionMap = {};
    let currentSectionId = null;

    function escapeHtml(text) {
      if (!text) return '';
      return String(text).replace(/[&<>"']/g, function(m) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m];
      });
    }

    function updateCrewDisplay() {
      var el = document.getElementById('crewScoreDisplay');
      if (el) el.textContent = crewScore;
    }

    function showPanel(id) {
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
      var panel = id ? document.getElementById('panel-' + id) : null;
      if (panel) {
        panel.classList.add('active');
      } else {
        var cp = document.getElementById('panel-complete');
        if (cp) {
          cp.classList.add('active');
          var fs = document.getElementById('finalScore');
          if (fs) fs.textContent = crewScore;
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function goToSection(id) {
      showPanel(id || null);
    }

    /* ===== DICE SYSTEM ===== */
    var diceState = {};

    function getDiceState(sid) {
      if (!diceState[sid]) {
        diceState[sid] = {
          values: [0, 0, 0, 0, 0],
          kept: [false, false, false, false, false],
          rollsLeft: 3,
          isRolling: false
        };
        for (var i = 0; i < 5; i++) {
          (function(idx, sectionId) {
            var keepBtn = document.getElementById('keep' + idx + '_' + sectionId);
            if (keepBtn) {
              keepBtn.addEventListener('click', function() {
                var state = diceState[sectionId];
                if (state.isRolling || state.values[idx] === 0) return;
                state.kept[idx] = !state.kept[idx];
                keepBtn.classList.toggle('active', state.kept[idx]);
                keepBtn.textContent = state.kept[idx] ? 'LOCKED' : 'LOCK';
                document.getElementById('die' + idx + '_' + sectionId).classList.toggle('kept', state.kept[idx]);
                updateChecklist(sectionId, false);
              });
            }
          })(i, sid);
          renderFace(i, 0, sid);
        }
      }
      return diceState[sid];
    }

    function renderFace(index, value, sid) {
      var face = document.getElementById('face' + index + '_' + sid);
      if (!face) return;
      face.innerHTML = '';
      if (value === 0) return;
      var layout = dotLayouts[value];
      for (var i = 0; i < 9; i++) {
        var dot = document.createElement('div');
        dot.className = 'dot';
        if (layout[i]) dot.style.visibility = 'visible';
        face.appendChild(dot);
      }
    }

    function updateChecklist(sid, includeFinal) {
      var state = diceState[sid];
      if (!state) return;
      var vals = [];
      for (var i = 0; i < 5; i++) {
        if (state.kept[i] || includeFinal) vals.push(state.values[i]);
      }
      var tmp = vals.slice();
      var i6 = tmp.indexOf(6); var has6 = i6 !== -1; if (has6) tmp.splice(i6, 1);
      var i5 = tmp.indexOf(5); var has5 = i5 !== -1; if (has5) tmp.splice(i5, 1);
      var i4 = tmp.indexOf(4); var has4 = i4 !== -1; if (has4) tmp.splice(i4, 1);
      var c6 = document.getElementById('check6_' + sid); if (c6) c6.classList.toggle('checked', has6);
      var c5 = document.getElementById('check5_' + sid); if (c5) c5.classList.toggle('checked', has5);
      var c4 = document.getElementById('check4_' + sid); if (c4) c4.classList.toggle('checked', has4);
    }

    async function rollDice(sid) {
      var state = getDiceState(sid);
      if (state.isRolling || state.rollsLeft <= 0) return;
      state.isRolling = true;
      state.rollsLeft--;

      var rollBtn = document.getElementById('rollBtn_' + sid);
      var rollsLeftTxt = document.getElementById('rollsLeft_' + sid);
      if (rollBtn) rollBtn.disabled = true;

      var toRoll = [];
      for (var i = 0; i < 5; i++) { if (!state.kept[i]) toRoll.push(i); }

      toRoll.forEach(function(i) {
        var box = document.getElementById('die' + i + '_' + sid);
        if (box) { box.classList.add('rolling'); box.classList.remove('settled'); }
      });

      var cycleTimers = {};
      toRoll.forEach(function(i) {
        cycleTimers[i] = setInterval(function() {
          renderFace(i, Math.floor(Math.random() * 6) + 1, sid);
        }, 60);
      });

      for (var order = 0; order < toRoll.length; order++) {
        await new Promise(function(resolve) { setTimeout(resolve, order === 0 ? 2500 : 800); });
        var dieIndex = toRoll[order];
        clearInterval(cycleTimers[dieIndex]);
        var finalValue = Math.floor(Math.random() * 6) + 1;
        state.values[dieIndex] = finalValue;
        renderFace(dieIndex, finalValue, sid);
        var box = document.getElementById('die' + dieIndex + '_' + sid);
        if (box) { box.classList.remove('rolling'); box.classList.add('settled'); }
      }

      // All dice have settled — safe to allow interaction now
      state.isRolling = false;

      var rl = state.rollsLeft;
      if (rollsLeftTxt) rollsLeftTxt.textContent = rl + ' ROLL' + (rl !== 1 ? 'S' : '') + ' LEFT';

      if (rl <= 0) {
        if (rollBtn) { rollBtn.disabled = true; rollBtn.textContent = 'NO ROLLS'; }
        if (rollsLeftTxt) rollsLeftTxt.textContent = 'TURN OVER';
        for (var j = 0; j < 5; j++) {
          var keepBtn = document.getElementById('keep' + j + '_' + sid);
          if (keepBtn) keepBtn.disabled = true;
        }
        updateChecklist(sid, true);
        finaliseDice(sid);
      } else {
        if (rollBtn) rollBtn.disabled = false;
        // Enable keep buttons only for dice that have a value (settled this roll or previously kept)
        for (var k = 0; k < 5; k++) {
          if (state.values[k] > 0 && !state.kept[k]) {
            var kbEnable = document.getElementById('keep' + k + '_' + sid);
            if (kbEnable) kbEnable.disabled = false;
          }
        }
      }
    }

    function finaliseDice(sid) {
      var state = diceState[sid];
      var scoreBox    = document.getElementById('scoreBox_'      + sid);
      var scoreLabel  = document.getElementById('scoreLabel_'    + sid);
      var scoreValue  = document.getElementById('scoreValue_'    + sid);
      var continueWrap = document.getElementById('continueWrap_' + sid);
      var resultText  = document.getElementById('diceResultText_' + sid);
      var actionBtn   = document.getElementById('diceActionBtn_' + sid);
      var outcome     = diceOutcomes[sid] || {};
      var difficulty  = outcome.difficulty !== undefined ? outcome.difficulty : 8;

      var vals = state.values.slice();
      var i6 = vals.indexOf(6);
      if (i6 === -1) { noCrewResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty); return; }
      vals.splice(i6, 1);
      var i5 = vals.indexOf(5);
      if (i5 === -1) { noCrewResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty); return; }
      vals.splice(i5, 1);
      var i4 = vals.indexOf(4);
      if (i4 === -1) { noCrewResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty); return; }
      vals.splice(i4, 1);

      var crew = vals[0] + vals[1];
      // Stat bonus: +0 for custom quests (no on-chain read)
      var statBonusVal = 0;
      var total = crew + statBonusVal;

      crewScore += crew;
      updateCrewDisplay();

      if (scoreBox) scoreBox.className = 'score-box scored';
      if (scoreLabel) scoreLabel.textContent = 'CREW';
      if (scoreValue) scoreValue.textContent = crew;

      if (total >= difficulty) {
        if (resultText) resultText.innerHTML = '<span class="highlight">' + crew + ' crew assembled.</span> Difficulty ' + difficulty + ' cleared. Press forward.';
        if (continueWrap) continueWrap.classList.add('show');
        if (actionBtn) actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(outcome.passNextId);
      } else {
        if (scoreBox) scoreBox.className = 'score-box no-score';
        if (resultText) resultText.innerHTML = 'Only <span class="highlight">' + crew + ' crew</span> — needed ' + difficulty + '. You fall short.';
        if (continueWrap) continueWrap.classList.add('show');
        if (actionBtn) actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(outcome.failNextId);
      }
    }

    function noCrewResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, failNextId, difficulty) {
      if (scoreBox) scoreBox.className = 'score-box no-score';
      if (scoreLabel) scoreLabel.textContent = 'NO CREW';
      if (scoreValue) scoreValue.textContent = '0';
      if (resultText) resultText.innerHTML = 'The dice forsake you. Needed ' + (difficulty || 8) + '. <span class="highlight">You push on alone.</span>';
      if (continueWrap) continueWrap.classList.add('show');
      if (actionBtn) actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(failNextId);
    }

    // Initialise dice state + event listeners for each dice section
${diceInitJs}
  <\/script>
</body>
</html>`;
}
