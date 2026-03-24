/**
 * GitHub API utilities for publishing quests
 * Uses personal access token for authentication
 */

class GitHubAPI {
  constructor(token, owner, repo, branch = 'main') {
    this.token = (token || '').trim();
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

  async getBlob(sha) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
  }

  async publishQuest(questName, sections, onProgress = null, introDialogue = '', introPhoto = null, questRewardsAddress = '', workerUrl = '', builderConfig = null) {
    // Count images up-front so we can report accurate progress
    let imageCount = 0;
    if (introPhoto) imageCount++;
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

      // Read quest index first to assign a stable on-chain questId
      progress('Updating quest manifest...');
      const indexJsonItem = treeItems.find(item => item.path === 'quests/index.json');
      let questIndex = [];
      if (indexJsonItem && indexJsonItem.sha) {
        try {
          const blobData = await this.getBlob(indexJsonItem.sha);
          const decoded = atob(blobData.content.replace(/\n/g, ''));
          questIndex = JSON.parse(decoded);
        } catch (e) {
          console.warn('Could not read existing quest index, starting fresh:', e);
          questIndex = [];
        }
      }
      // Assign questId: reuse existing if re-publishing, otherwise next available slot
      const existingEntry = questIndex.find(q => q.slug === sanitized);
      const questId = existingEntry != null ? existingEntry.questId : questIndex.length;
      if (!existingEntry) {
        questIndex.push({ name: questName, slug: sanitized, questId });
      }
      const indexBlob = await this.createBlob(JSON.stringify(questIndex, null, 2), 'utf-8');
      const indexIdx = treeItems.findIndex(item => item.path === 'quests/index.json');
      if (indexIdx !== -1) treeItems.splice(indexIdx, 1);
      treeItems.push({
        path: 'quests/index.json',
        mode: '100644',
        type: 'blob',
        sha: indexBlob.sha
      });
      console.log(`✓ Quest manifest updated (questId=${questId})`);

      // Generate quest HTML with the assigned questId
      progress('Generating quest HTML...');
      const questHTML = generateQuestHTML(questName, sections, introDialogue, !!introPhoto, questRewardsAddress, questId, workerUrl, builderConfig);
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
        JSON.stringify({ name: questName, questId, sections: cleanSections }, null, 2),
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

      // Upload intro photo if provided
      if (introPhoto) {
        const introParts = introPhoto.split(',');
        const introData = introParts.length > 1 ? introParts[1] : introParts[0];
        if (introData) {
          progress('Uploading intro image...');
          const introBlob = await this.createBlob(introData, 'base64');
          treeItems.push({
            path: `${imagesPath}/intro.png`,
            mode: '100644',
            type: 'blob',
            sha: introBlob.sha
          });
          uploadedImages++;
        }
      }

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
 * Generate quest player HTML
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

function generateQuestHTML(questName, sections, introDialogue = '', hasIntroPhoto = false, questRewardsAddress = '', questId = 0, workerUrl = '', builderConfig = null) {
  // Use builder config for item data if available, otherwise fall back to inline defaults
  const _cfg = builderConfig || (typeof BUILDER_CONFIG !== 'undefined' ? BUILDER_CONFIG : null);
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

  // Build double-choice map for choice tracking (choice1/choice2 for completeQuest)
  // Maps sectionId → { next1, next2 } so goToSection can record which branch was taken
  const doubleChoiceMap = {};
  sections.forEach(s => {
    if (s.selectedChoice === 'double') {
      doubleChoiceMap[s.id] = {
        next1: s.choice1NextSectionId || null,
        next2: s.choice2NextSectionId || null
      };
    }
  });
  const diceSectionIds = sections.filter(s => s.selectedChoice === 'dice').map(s => s.id);

  // Build section → music map (paths are relative to site root; prefix ../../ for quests subfolder)
  const sectionMusic = {};
  sections.forEach(s => {
    if (s.music) {
      sectionMusic[s.id] = '../../' + s.music;
    }
  });
  const sectionMusicJson = JSON.stringify(sectionMusic);

  // Build item awards map and name lookup (from builder-config.js if available)
  const knownItems = {};
  if (_cfg && _cfg.knownItems) {
    Object.keys(_cfg.knownItems).forEach(id => { knownItems[id] = _cfg.knownItems[id].name; });
  } else {
    knownItems['1'] = "Cindy's Code";
  }
  const itemAwards = {};
  sections.forEach(s => {
    if (s.itemAward) itemAwards[s.id] = s.itemAward;
  });
  const itemAwardsJson = JSON.stringify(itemAwards);

  const introLines = introDialogue
    ? introDialogue.split('\n').map(l => l.trim()).filter(Boolean)
    : [];
  const introLinesJson = JSON.stringify(introLines);

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
    const rawImgHtml = section.photo
      ? `<img src="images/${sid}.png" alt="${sectionName}" class="section-img">`
      : (section.selectedChoice === 'dice' && section.diceImage
          ? `<img src="images/dice-${sid}.png" alt="${sectionName}" class="section-img">`
          : '');
    const gameIframeHtml = (section.gameFile && section.selectedChoice !== 'minigame')
      ? `<div class="dialogue-frame"><iframe src="../../games/${escapeHtml(section.gameFile)}" class="section-game-frame" allowfullscreen></iframe></div>`
      : '';
    const topImageHtml = gameIframeHtml || (rawImgHtml
      ? `<div class="dialogue-frame">${rawImgHtml}</div>`
      : '');

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
      // Full Ship-Captain-Score dice section
      const statLabelMap = {
        strength: 'STRENGTH', intelligence: 'INTELLIGENCE',
        dexterity: 'DEXTERITY', charisma: 'CHARISMA'
      };
      const statLabel = statLabelMap[section.statBonus] || 'STAT';
      const difficulty = section.difficulty !== undefined ? section.difficulty : 8;

      const diceColsHtml = [0,1,2,3,4].map(i => `
              <div class="dice-col">
                <div class="dice-box" id="die${i}_${sid}" onclick="toggleDie(${i}, ${sid})"><div class="dice-face" id="face${i}_${sid}"></div></div>
                <button class="keep-btn" id="keep${i}_${sid}" onclick="toggleDie(${i}, ${sid})">LOCK</button>
              </div>`).join('');

      actionHtml = `
        <div class="quest-hud" id="questHud_${sid}" style="opacity:0">
          <div class="hud-portrait-row">
            <div class="hud-portrait-col">
              <div class="hud-portrait-frame">
                <img id="hudChadImg_${sid}" src="" alt="Chad NFT">
              </div>
            </div>
            <div class="hud-stats-panel">
              <div class="hud-stat-box"><div class="hud-stat-label">STR</div><div class="hud-stat-value" id="hudStr_${sid}">—</div></div>
              <div class="hud-stat-box"><div class="hud-stat-label">INT</div><div class="hud-stat-value" id="hudInt_${sid}">—</div></div>
              <div class="hud-stat-box"><div class="hud-stat-label">DEX</div><div class="hud-stat-value" id="hudDex_${sid}">—</div></div>
              <div class="hud-stat-box"><div class="hud-stat-label">CHA</div><div class="hud-stat-value" id="hudCha_${sid}">—</div></div>
            </div>
          </div>
          <div class="hud-cells-row" id="hudCellsRow_${sid}" style="display:flex;gap:8px;justify-content:center;margin-top:8px;width:100%;">
            <div class="hud-stat-box" style="flex:1;"><div class="hud-stat-label">LVL</div><div class="hud-stat-value" id="hudLvl_${sid}">—</div></div>
            <div class="hud-stat-box" style="flex:1;"><div class="hud-stat-label">OPEN</div><div class="hud-stat-value" id="hudOpen_${sid}">—</div></div>
            <div class="hud-stat-box" style="flex:1;"><div class="hud-stat-label">LOCKED</div><div class="hud-stat-value" id="hudClosed_${sid}">—</div></div>
          </div>
          <div class="hud-items-row" id="hudItemsRow_${sid}">
            <div class="hud-item-label">EQUIPPED</div>
          </div>
        </div>
        <div class="dice-section" style="opacity:0">
          <div class="dice-meta-tag">${statLabel} BONUS <span id="statBonusVal_${sid}" data-stat="${section.statBonus}">+0</span> &nbsp;&nbsp; DIFFICULTY: ${difficulty}</div>
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

    } else if (section.selectedChoice === 'minigame') {
      // Embedded minigame iframe — win advances, loss triggers death sequence
      actionHtml = `
        <div class="minigame-fullscreen-wrap" id="minigameWrap_${sid}">
          <div class="mg-loading-screen" id="mgLoading_${sid}">LOADING...</div>
          <iframe class="section-game-frame section-minigame-frame" id="minigameFrame_${sid}" src="" allowfullscreen allow="autoplay" data-section-id="${sid}"></iframe>
        </div>`;

    } else {
      // Fallback: terminal section
      actionHtml = `<button class="action-btn" onclick="goToSection(null)">CONTINUE</button>`;
    }

    const itemId = section.itemAward || null;
    const itemName = itemId ? (escapeHtml(knownItems[itemId] || ('Item #' + itemId))) : null;
    const claimWrapHtml = itemId ? `
          <div class="item-claim-wrap" id="itemClaimWrap_${sid}">
            <div class="item-award-label">ITEM REWARD: ${itemName}</div>
            <button class="claim-item-btn" id="claimItemBtn_${sid}" onclick="claimSectionItem(${sid})">CLAIM ITEM</button>
            <div class="loading-text" id="claimItemStatus_${sid}"></div>
            <button class="skip-item-link" onclick="skipItemClaim(${sid})">skip</button>
          </div>
          <div id="sectionAction_${sid}" style="display:none;">
            ${actionHtml}
          </div>` : actionHtml;

    return `
      <!-- ${sectionName} -->
      <div class="panel${isFirst ? ' active' : ''}" id="panel-${sid}">
        ${topImageHtml}
        <div class="narrative">
          ${dialogueHtml}
        </div>
        <div class="action-wrap">
          ${claimWrapHtml}
        </div>
      </div>`;
  }).join('\n');

  // Quest complete panel
  const completePanelHtml = `
      <!-- Quest Complete -->
      <div class="panel" id="panel-complete">
        <div class="narrative">
          <p>You have reached the end of <span class="highlight">${escapeHtml(questName)}</span>.</p>
          <p>Congratulations you did not die.</p>
        </div>
        <div class="claim-xp-section">
          <div id="xpPreview" style="margin-bottom:12px;display:none;">
            <div style="font-size:0.6em;color:#aaa;margin-bottom:6px;letter-spacing:0.08em;">CELLS EARNED IN QUEST</div>
            <div style="font-size:1.1em;color:#ffd700;"><span id="xpPreviewValue">0</span></div>
          </div>
          <button class="claim-xp-btn" id="claimXpBtn" onclick="claimQuestXP()">CLAIM REWARDS</button>
          <div class="loading-text" id="claimXpStatus" style="margin-top:8px;"></div>
        </div>
        <div class="action-wrap" id="returnWrap" style="display:none;">
          <button class="action-btn" onclick="window.location.href='../../chadbase.html'">BACK TO BASE</button>
        </div>
      </div>`;

  const diceOutcomesJson = JSON.stringify(diceOutcomes);
  const doubleChoiceMapJson = JSON.stringify(doubleChoiceMap);
  const diceInitJs = diceSectionIds.map(id => `    getDiceState(${id});`).join('\n');

  // Map sectionId → { gameFile, nextSectionId } for embedded game sections
  const gameSectionMap = {};
  sections.forEach(s => {
    if (s.gameFile) {
      gameSectionMap[s.id] = {
        gameFile: s.gameFile,
        nextSectionId: s.nextSectionId || null,
      };
    }
  });
  const gameSectionMapJson = JSON.stringify(gameSectionMap);

  // Map sectionId → { minigameFile, winNextSectionId } for minigame sections
  const minigameSectionMap = {};
  sections.forEach(s => {
    if (s.selectedChoice === 'minigame') {
      minigameSectionMap[s.id] = {
        minigameFile: s.minigameFile || 'runner.html',
        winNextSectionId: s.minigameWinNextSectionId || null,
      };
    }
  });
  const minigameSectionMapJson = JSON.stringify(minigameSectionMap);

  // Map sectionId → cells awarded when player enters that section (tracked server-side)
  const sectionXpMap = {};
  sections.forEach(s => {
    if (s.sectionXp && Number(s.sectionXp) > 0) sectionXpMap[s.id] = Number(s.sectionXp);
  });
  const sectionXpMapJson = JSON.stringify(sectionXpMap);

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

    .bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      background-image: url('../../assets/mainbg.png');
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
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
      /* needed so .chad-name absolute positioning is contained */
      overflow: visible;
    }
    .chad-name {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      font-size: 0.55rem;
      color: #c9a84c;
      text-align: center;
      text-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
      white-space: nowrap;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
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

    .dialogue-frame {
      display: block;
      position: relative;
      width: 100%;
      max-width: 310px;
      margin: 0 auto 20px;
      background: url('../../assets/dialogue.jpg') no-repeat center / 100% 100%;
      padding: 28px;
    }
    .section-img {
      width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
      opacity: 0;
    }
    .section-game-frame {
      width: 100%;
      aspect-ratio: 2 / 3;
      height: auto;
      border: none;
      display: block;
    }

    /* Quest HUD — adventure.html style: portrait (left) + stats (right), items row below */
    .quest-hud {
      width: 100%;
      max-width: 560px;
      margin-bottom: 20px;
    }
    .hud-portrait-row {
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      gap: 8px;
      margin-top: 4px;
    }
    .hud-portrait-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-shrink: 0;
    }
    .hud-portrait-frame {
      width: clamp(160px, 48vw, 240px);
      height: auto;
      border: 4px solid #c9a84c;
      border-radius: 4px;
      background: rgba(30, 20, 10, 0.8);
      overflow: hidden;
      box-shadow:
        inset 0 0 20px rgba(0, 0, 0, 0.3),
        0 0 20px rgba(201, 168, 76, 0.2),
        0 0 40px rgba(201, 168, 76, 0.1);
      image-rendering: pixelated;
      min-height: 100px;
    }
    .hud-portrait-frame img {
      width: 100%;
      height: auto;
      image-rendering: pixelated;
      display: block;
    }
    .hud-stats-panel {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1;
      align-content: flex-start;
      padding-top: 4px;
    }
    .hud-stat-box {
      background: url('https://lastchad.xyz/assets/stat-frame.png') center/100% 100% no-repeat;
      padding: 12px 8px;
      text-align: center;
      flex: 1 1 calc(50% - 4px);
      min-width: 0;
      box-sizing: border-box;
    }
    .hud-stat-label {
      font-size: 0.52rem;
      color: #8a7a5a;
      margin-bottom: 4px;
    }
    .hud-stat-value {
      font-size: 0.85rem;
      color: #c9a84c;
    }
    .hud-stat-value.boosted { color: #f7931a; text-shadow: 0 0 8px rgba(247,147,26,0.6); }
    .hud-items-row {
      display: none;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 12px;
      width: 100%;
      max-width: 400px;
    }
    .hud-items-row.has-items { display: flex; }
    .hud-item-label {
      font-size: 0.42rem;
      color: #5c4409;
      text-align: center;
      width: 100%;
      margin-bottom: 2px;
      letter-spacing: 0.1em;
    }
    .hud-item-badge {
      background: rgba(30, 20, 10, 0.7);
      border: 2px solid #c9a84c;
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 0.38rem;
      color: #c9a84c;
      text-align: center;
      line-height: 1.6;
      box-shadow: 0 0 8px rgba(201, 168, 76, 0.15);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .hud-item-badge img {
      width: 56px;
      height: 56px;
      object-fit: cover;
      border-radius: 3px;
      display: block;
    }

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
      opacity: 0;
    }
    .narrative p + p { margin-top: 14px; }
    .narrative.typing p { display: none; }
    .typewriter-line {
      font-size: clamp(0.5rem, 1.8vw, 0.65rem);
      line-height: 2.2;
      color: #f5e6c8;
      min-height: 2.4em;
    }
    .typewriter-cursor {
      display: inline-block;
      width: 0.55em;
      height: 0.9em;
      background: #c9a84c;
      margin-left: 1px;
      vertical-align: text-bottom;
      animation: blink-cursor 0.7s step-end infinite;
    }
    @keyframes blink-cursor { 50% { opacity: 0; } }
    .action-wrap { opacity: 0; pointer-events: none; }
    .result-success { color: #c9a84c; }
    .result-fail { color: #e53935; }
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
    .dice-col { display: flex; flex-direction: column; align-items: center; gap: 8px; perspective: 400px; }

    .dice-box {
      width: clamp(48px, 13vw, 72px);
      height: clamp(48px, 13vw, 72px);
      background: linear-gradient(145deg,
        #f8f8f8 0%,
        #e6e6e6 18%,
        #d2d2d2 36%,
        #c4c4c4 52%,
        #b2b2b2 68%,
        #a2a2a2 82%,
        #929292 100%
      );
      border: 2px solid #9a9a9a;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      transition: border-color 0.2s, box-shadow 0.2s;
      box-shadow:
        inset 3px 3px 8px rgba(255, 255, 255, 0.88),
        inset -2px -2px 6px rgba(0, 0, 0, 0.28),
        2px 2px 0 #878787,
        3px 3px 0 #767676,
        4px 4px 0 #656565,
        5px 5px 12px rgba(0, 0, 0, 0.72);
    }
    @keyframes dice-tumble {
      0%   { transform: rotateX(0deg)   rotateZ(0deg); }
      100% { transform: rotateX(360deg) rotateZ(270deg); }
    }
    .dice-box.rolling {
      animation: dice-tumble 0.28s linear infinite;
      border-color: #c9a84c;
      box-shadow:
        inset 3px 3px 8px rgba(255, 255, 255, 0.88),
        inset -2px -2px 6px rgba(0, 0, 0, 0.28),
        2px 2px 0 #878787,
        3px 3px 0 #767676,
        4px 4px 0 #656565,
        5px 5px 12px rgba(0, 0, 0, 0.72),
        0 0 18px rgba(201, 168, 76, 0.45);
    }
    .dice-box.kept {
      border-color: #4caf50;
      box-shadow:
        inset 3px 3px 8px rgba(255, 255, 255, 0.88),
        inset -2px -2px 6px rgba(0, 0, 0, 0.24),
        2px 2px 0 #878787,
        3px 3px 0 #767676,
        4px 4px 0 #656565,
        5px 5px 12px rgba(0, 0, 0, 0.72),
        0 0 12px rgba(76, 175, 80, 0.35);
    }
    .dice-box.settled { border-color: #c9a84c; }

    .dice-face {
      width: 100%; height: 100%;
      display: grid;
      grid-template-rows: 1fr 1fr 1fr;
      grid-template-columns: 1fr 1fr 1fr;
      padding: 14%;
      gap: 2px;
    }
    .dice-face .dot {
      width: 100%;
      aspect-ratio: 1;
      background: #111;
      border-radius: 50%;
      box-shadow:
        inset 1px 1px 3px rgba(0, 0, 0, 0.95),
        0 1px 1px rgba(255, 255, 255, 0.18);
    }
    .dice-box.kept .dice-face .dot {
      background: #111;
      box-shadow:
        inset 1px 1px 3px rgba(0, 0, 0, 0.95),
        0 1px 1px rgba(255, 255, 255, 0.18);
    }
    .dot { visibility: hidden; }

    .dice-box.settled { cursor: pointer; }
    .dice-box.kept    { cursor: pointer; }

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


    @media (max-width: 480px) {
      .header { padding: 12px 16px; }
      .quest-panel { padding: 20px 16px; }
      .dice-row { gap: 5px; }
    }

    /* === Desktop === */
    @media (min-width: 900px) {
      .quest-panel { max-width: 680px; padding: 32px 36px; }
      .quest-hud { max-width: 680px; }
      .intro-box { max-width: 680px; padding: 48px 44px; }
      .dice-box { width: 90px; height: 90px; }
      .keep-btn { width: 90px; font-size: 0.45rem; }
      .score-box { min-width: 360px; }
      .roll-btn { padding: 16px 52px; }
    }

    /* Intro overlay */
    #intro-overlay {
      position: fixed;
      inset: 0;
      z-index: 999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.92);
      transition: opacity 1.2s ease;
      animation: intro-appear 0.8s ease;
    }
    #intro-overlay.hidden {
      opacity: 0;
      pointer-events: none;
    }
    @keyframes intro-appear {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .intro-box {
      background: rgba(10, 8, 4, 0.97);
      border: 3px solid #c9a84c;
      border-radius: 6px;
      padding: 40px 36px;
      max-width: 560px;
      width: 92%;
      box-shadow: 0 0 40px rgba(201, 168, 76, 0.25), inset 0 0 20px rgba(0,0,0,0.5);
      text-align: center;
    }
    .intro-title {
      font-size: clamp(0.55rem, 2vw, 0.8rem);
      color: #c9a84c;
      text-shadow: 0 0 12px rgba(201, 168, 76, 0.4);
      margin-bottom: 28px;
      letter-spacing: 0.04em;
    }
    .intro-text {
      font-size: clamp(0.38rem, 1.5vw, 0.52rem);
      line-height: 2.4;
      color: #f5e6c8;
      margin-bottom: 36px;
      text-align: center;
    }
    .intro-text p { margin-bottom: 14px; }
    .intro-start-btn {
      background: linear-gradient(135deg, rgba(201, 168, 76, 0.3) 0%, rgba(201, 168, 76, 0.1) 100%);
      border: 2px solid #c9a84c;
      color: #c9a84c;
      padding: 14px 44px;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.45rem, 1.8vw, 0.6rem);
      cursor: pointer;
      border-radius: 4px;
      text-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
      transition: all 0.3s;
      letter-spacing: 0.05em;
    }
    .intro-start-btn:hover {
      background: linear-gradient(135deg, rgba(201, 168, 76, 0.45) 0%, rgba(201, 168, 76, 0.2) 100%);
      box-shadow: 0 0 20px rgba(201, 168, 76, 0.35);
      transform: translateY(-1px);
    }
    .intro-start-btn:active { transform: scale(0.97); }
    .intro-start-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

    /* Wallet button */
    .wallet-btn {
      font-family: 'Press Start 2P', monospace;
      font-size: 0.55rem;
      padding: 10px 18px;
      background: linear-gradient(180deg, #b0bec5 0%, #78909c 50%, #546e7a 100%);
      border: 3px solid #90a4ae;
      border-radius: 0;
      color: #0d1a1f;
      cursor: pointer;
      transition: all 0.15s;
      box-shadow: inset 0 2px 0 rgba(255,255,255,0.3), inset 0 -2px 0 rgba(0,0,0,0.35), 0 4px 0 #37474f, 0 6px 0 #263238, 0 8px 10px rgba(0,0,0,0.5);
      letter-spacing: 0.04em;
    }
    .wallet-btn:hover { background: linear-gradient(180deg, #cfd8dc 0%, #90a4ae 50%, #607d8b 100%); border-color: #b0bec5; }
    .wallet-btn:active { transform: translateY(4px); box-shadow: inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 0 #37474f, 0 2px 6px rgba(0,0,0,0.5); }
    .wallet-btn.connected { background: linear-gradient(180deg, #78909c 0%, #546e7a 50%, #37474f 100%); border-color: #90a4ae; color: #eceff1; font-size: 0.5rem; box-shadow: inset 0 2px 0 rgba(255,255,255,0.15), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #263238, 0 6px 0 #1a2a30, 0 8px 10px rgba(0,0,0,0.5); }
    .wallet-wrapper { position: relative; }
    .disconnect-dropdown { display: none; position: absolute; top: calc(100% + 6px); right: 0; background: linear-gradient(180deg, #1e1608 0%, #140f05 100%); border: 2px solid #5c4409; border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,0.7); z-index: 110; min-width: 160px; }
    .disconnect-dropdown.show { display: block; }
    .disconnect-btn { width: 100%; padding: 12px 16px; font-family: 'Press Start 2P', monospace; font-size: 0.45rem; color: #e53935; background: none; border: none; cursor: pointer; text-align: center; transition: background 0.15s; }
    .disconnect-btn:hover { background: rgba(229, 57, 53, 0.15); }

    /* Music toggle button */
    .music-toggle {
      position: fixed;
      top: 70px;
      right: 16px;
      z-index: 150;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(20, 15, 5, 0.55);
      border: 1px solid rgba(201, 168, 76, 0.45);
      color: #c9a84c;
      font-size: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      backdrop-filter: blur(6px);
      transition: background 0.2s, border-color 0.2s, opacity 0.2s;
    }
    .music-toggle:hover { background: rgba(40, 28, 8, 0.75); border-color: rgba(201, 168, 76, 0.8); }
    .music-toggle.muted { opacity: 0.45; }

    /* Wallet & level-up modals */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 200; align-items: center; justify-content: center; padding: 20px; }
    .modal-overlay.show { display: flex; }
    .modal { background: linear-gradient(180deg, #1e1608 0%, #140f05 100%); border: 3px solid #5c4409; border-radius: 8px; padding: 28px 24px; max-width: 380px; width: 100%; box-shadow: 0 0 40px rgba(0,0,0,0.8), 0 0 20px rgba(139,105,20,0.15); }
    .modal-title { font-size: 0.7rem; color: #c9a84c; text-align: center; margin-bottom: 24px; }
    .wallet-option { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 16px; margin-bottom: 10px; font-family: 'Press Start 2P', monospace; font-size: 0.5rem; color: #f5e6c8; background: rgba(61,46,10,0.3); border: 2px solid #3d2e0a; border-radius: 4px; cursor: pointer; transition: all 0.15s; }
    .wallet-option:hover { border-color: #8b6914; background: rgba(92,68,9,0.3); }
    .wallet-icon { width: 32px; height: 32px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; }
    .modal-close { display: block; margin: 16px auto 0; font-family: 'Press Start 2P', monospace; font-size: 0.45rem; color: #5c4409; background: none; border: none; cursor: pointer; padding: 8px; }
    .modal-close:hover { color: #c9a84c; }

    .loading-text { font-size: 0.4rem; color: #8a7a5a; text-align: center; padding: 10px 0; }

    /* Quest complete panel extras */
    .claim-xp-section { margin-bottom: 20px; }
    .claim-xp-btn {
      width: 100%;
      padding: 16px 40px;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.65rem, 2.5vw, 0.85rem);
      color: #fff;
      background: linear-gradient(180deg, #c9a84c 0%, #8b6914 50%, #5c4409 100%);
      border: 3px solid #d4a017;
      border-radius: 6px;
      cursor: pointer;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
      box-shadow: inset 0 2px 0 rgba(255,220,120,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #3d2e0a, 0 6px 15px rgba(0,0,0,0.5);
      transition: all 0.2s;
      touch-action: manipulation;
    }
    .claim-xp-btn:hover { background: linear-gradient(180deg, #dabb5e 0%, #a07d1e 50%, #6b5010 100%); border-color: #f5e6c8; }
    .claim-xp-btn:active { transform: translateY(3px); }
    .claim-xp-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

    /* Completed banner */
    .quest-completed-banner { background: rgba(76,175,80,0.1); border: 2px solid #4caf50; border-radius: 6px; padding: 16px; text-align: center; font-size: 0.5rem; color: #4caf50; line-height: 2; margin-bottom: 16px; }

    /* Item claim */
    .item-claim-wrap { margin-bottom: 0; }
    .item-award-label { font-size: clamp(0.35rem, 1.4vw, 0.48rem); color: #7ee8d4; text-align: center; margin-bottom: 12px; letter-spacing: 0.05em; text-shadow: 0 0 6px rgba(126,232,212,0.3); }
    .claim-item-btn { width: 100%; padding: 16px 40px; font-family: 'Press Start 2P', monospace; font-size: clamp(0.65rem, 2.5vw, 0.85rem); color: #fff; background: linear-gradient(180deg, #4caf50 0%, #2e7d32 50%, #1b5e20 100%); border: 3px solid #66bb6a; border-radius: 6px; cursor: pointer; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000; box-shadow: inset 0 2px 0 rgba(160,230,160,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #1b5e20, 0 6px 15px rgba(0,0,0,0.5); transition: all 0.2s; touch-action: manipulation; animation: item-glow 2s ease-in-out infinite; }
    .claim-item-btn:hover { animation: none; background: linear-gradient(180deg, #66bb6a 0%, #388e3c 50%, #2e7d32 100%); border-color: #a5d6a7; }
    .claim-item-btn:active { transform: translateY(3px); }
    .claim-item-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; animation: none; }
    @keyframes item-glow {
      0%, 100% { box-shadow: inset 0 2px 0 rgba(160,230,160,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #1b5e20, 0 6px 15px rgba(0,0,0,0.5), 0 0 15px rgba(76,175,80,0.2); }
      50%       { box-shadow: inset 0 2px 0 rgba(160,230,160,0.4), inset 0 -2px 0 rgba(0,0,0,0.4), 0 4px 0 #1b5e20, 0 6px 15px rgba(0,0,0,0.5), 0 0 28px rgba(76,175,80,0.45); }
    }
    .skip-item-link { display: block; margin-top: 10px; width: 100%; background: none; border: none; font-family: 'Press Start 2P', monospace; font-size: 0.3rem; color: #5c4409; text-align: center; cursor: pointer; padding: 4px; }
    .skip-item-link:hover { color: #8a7a5a; }

    /* Item info popup */
    #itemPopupOverlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.80); z-index: 9999;
      align-items: center; justify-content: center; cursor: pointer;
    }
    #itemPopupOverlay.open { display: flex; }
    #itemPopup {
      background: #1a1208; border: 2px solid #c9a84c;
      padding: 28px 20px 22px; max-width: 300px; width: 88%;
      position: relative; box-shadow: 0 0 40px rgba(201,168,76,0.2);
      cursor: default;
    }
    #itemPopupClose {
      position: absolute; top: 8px; right: 10px;
      background: none; border: none; color: #c9a84c;
      font-family: 'Press Start 2P', monospace;
      font-size: 0.65rem; cursor: pointer; line-height: 1; padding: 4px 6px;
    }
    #itemPopupClose:hover { color: #fff; }
    #itemPopupImg { width: 100%; max-width: 180px; display: block; margin: 0 auto 14px; border: 1px solid #5c4409; }
    #itemPopupName { font-family: 'Press Start 2P', monospace; font-size: 0.52rem; color: #c9a84c; text-align: center; margin-bottom: 12px; line-height: 1.8; }
    #itemPopupDesc { font-family: 'Press Start 2P', monospace; font-size: 0.40rem; color: #f5e6c8; line-height: 2.2; margin-bottom: 12px; }
    #itemPopupStats { font-family: 'Press Start 2P', monospace; font-size: 0.42rem; color: #4caf50; line-height: 2; }
    .hud-item-badge { cursor: pointer; }
    .hud-item-badge:hover img { opacity: 0.8; }

    /* Cells box — running cells counter (top-right, non-game sections only) */
    .exp-box {
      position: fixed;
      top: 116px;
      right: 16px;
      z-index: 150;
      border: 2px solid #c9a84c;
      border-radius: 4px;
      background: rgba(20, 14, 4, 0.88);
      box-shadow: 0 0 8px rgba(201, 168, 76, 0.2), inset 0 0 6px rgba(0,0,0,0.4);
      padding: 6px 10px;
      text-align: center;
      min-width: 56px;
      display: none;
      backdrop-filter: blur(4px);
    }
    .exp-box-label {
      font-size: 0.35rem;
      color: #c9a84c;
      letter-spacing: 0.1em;
      margin-bottom: 4px;
    }
    .exp-box-value {
      font-size: 0.6rem;
      color: #ffe96a;
    }

    /* Minigame fullscreen mode — hides chrome, shows only the game */
    body.minigame-active .header,
    body.minigame-active .music-toggle,
    body.minigame-active .exp-box,
    body.minigame-active .bg,
    body.minigame-active .narrative,
    body.minigame-active .section-img,
    body.minigame-active .quest-hud { display: none !important; }
    body.minigame-active main,
    body.minigame-active .quest-panel,
    body.minigame-active .panel.active,
    body.minigame-active .action-wrap { padding: 0 !important; margin: 0 !important; background: none !important; }
    body.minigame-active .minigame-fullscreen-wrap {
      position: fixed;
      inset: 0;
      z-index: 8000;
      background: #000;
    }
    body.minigame-active .minigame-fullscreen-wrap iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      position: relative;
      z-index: 1;
    }
    .mg-loading-screen {
      display: none;
      position: absolute;
      inset: 0;
      align-items: center;
      justify-content: center;
      font-family: monospace;
      font-size: 20px;
      font-weight: bold;
      letter-spacing: 2px;
      color: #f5e6c8;
      background: #111;
      z-index: 2;
      pointer-events: none;
      animation: mgLoadingPulse 0.7s ease-in-out infinite alternate;
    }
    body.minigame-active .mg-loading-screen { display: flex; }
    .mg-loading-screen.mg-hidden { display: none !important; }
    @keyframes mgLoadingPulse {
      from { opacity: 0.4; }
      to { opacity: 1.0; }
    }
    #mg-tap-overlay {
      position: fixed;
      inset: 0;
      z-index: 9000;
      background: rgba(0,0,0,0.01);
      border: none;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      display: none;
    }
    body.minigame-active #mg-tap-overlay { display: block; }

    /* Minigame death overlay */
    #minigame-death-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: url('../../assets/mainbg.png') center/cover no-repeat;
      align-items: center;
      justify-content: center;
      z-index: 9000;
      opacity: 0;
      transition: opacity 0.8s ease;
    }
    #minigame-death-overlay.visible { opacity: 1; }
    #minigame-death-overlay.show { display: flex; }
    .minigame-death-dialogue {
      background: url('../../assets/dialogue.jpg') center/100% 100% no-repeat;
      padding: 52px 44px;
      text-align: center;
      font-family: 'Press Start 2P', monospace;
      font-size: clamp(0.7rem, 2.5vw, 1.1rem);
      color: #f5e6c8;
      max-width: 420px;
      width: 90%;
      text-shadow: 2px 2px 0 #000;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <!-- Parent-side tap relay: works in WebViews where iframe taps are eaten -->
  <button id="mg-tap-overlay" aria-label="Tap to start"></button>
  <!-- Minigame death overlay -->
  <div id="minigame-death-overlay">
    <div class="minigame-death-dialogue">You have died</div>
  </div>

  <!-- Item info popup -->
  <div id="itemPopupOverlay">
    <div id="itemPopup">
      <button id="itemPopupClose">X</button>
      <img id="itemPopupImg" src="" alt="">
      <div id="itemPopupName"></div>
      <div id="itemPopupDesc"></div>
      <div id="itemPopupStats"></div>
    </div>
  </div>

  <!-- Intro overlay — appears before any panel content loads -->
  <div id="intro-overlay">
    <div class="intro-box">
      ${hasIntroPhoto ? `<img src="images/intro.png" alt="${escapeHtml(questName)}" style="width:100%;max-width:460px;height:auto;border-radius:4px;margin-bottom:20px;display:block;margin-left:auto;margin-right:auto;">` : ''}
      <div class="intro-title">${escapeHtml(questName)}</div>
      ${introLines.length > 0 ? '<div id="introText" class="intro-text" style="opacity:0;"></div>' : ''}
<div id="introCompletedBanner" style="display:none;" class="quest-completed-banner">CHAD #<span id="introCompletedId"></span> HAS ALREADY COMPLETED THIS QUEST</div>
      <div id="escrowBox" style="margin:18px 0 10px;font-size:0.48rem;color:#c9a84c;text-align:center;line-height:1.8;">
        <div id="escrowStatus" style="margin-bottom:10px;">⏳ Checking quest status…</div>
        <a href="../../adventure.html" id="goAdventureBtn" style="display:none;font-family:'Press Start 2P',monospace;font-size:0.48rem;color:#c9a84c;text-decoration:underline;cursor:pointer;">← Start quest from the Adventure page</a>
      </div>
      <button class="intro-start-btn" id="introStartBtn" onclick="startQuest()" disabled${introLines.length > 0 ? ' style="opacity:0;pointer-events:none;"' : ''}>START</button>
    </div>
  </div>

  <div class="bg"></div>

  <header class="header">
    <div id="nav-placeholder"></div>
    <span class="chad-name" id="chadName">${escapeHtml(questName)}</span>
    <div class="wallet-wrapper">
      <button class="wallet-btn" id="walletBtn">Connect Wallet</button>
      <div class="disconnect-dropdown" id="disconnectDropdown">
        <button class="disconnect-btn" id="disconnectBtn">DISCONNECT</button>
      </div>
    </div>
  </header>
  <button class="music-toggle" id="musicToggleBtn" onclick="toggleQuestMusic()" title="Toggle music">♪</button>
  <div class="exp-box" id="expBox">
    <div class="exp-box-label">CELLS</div>
    <div class="exp-box-value" id="expBoxValue">0</div>
  </div>

  <main class="main">

    <div class="quest-panel">
${panelsHtml}
${completePanelHtml}
    </div>
  </main>

  <!-- Wallet Modal -->
  <div id="wallet-modal-placeholder"></div>



  <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"><\/script>
  <script src="../../js/quest-globals.js"><\/script>
  <script src="../../js/wallet-modal.js"><\/script>
  <script src="../../nav.js"><\/script>
  <script>
    var _animGen = 0;
    var _questRunnerXP = 0; // cells earned from runner minigame (HUD display)
    var _runnerScores = {}; // sectionId → runnerXP, for worker replay on reload
    var _sectionCells = 0; // cells earned from section visits
    var _visitedSections = {}; // tracks visited sections to avoid double-counting
    var _scoredDiceSections = {}; // sectionId → cargoScore already sent to worker

    function updateExpBox() {
      var total = _questRunnerXP + _sectionCells;
      Object.keys(diceOutcomes).forEach(function(sid) {
        total += (diceState[Number(sid)] && diceState[Number(sid)].totalScore) || 0;
      });
      var el = document.getElementById('expBoxValue');
      if (el) el.textContent = total;
    }

    // ===== IN-PROGRESS SESSION PERSISTENCE =====
    // Saves seed + current section + score so reloads resume from the same point.
    function _progressKey() { return 'lc_qprog_' + QUEST_SLUG + '_' + chadId; }
    function _saveProgress() {
      if (!chadId) return;
      var scores = {};
      var cargoScores = {};
      Object.keys(diceState).forEach(function(sid) {
        if (diceState[sid].totalScore) scores[sid] = diceState[sid].totalScore;
        if (diceState[sid].cargoScore != null) cargoScores[sid] = diceState[sid].cargoScore;
      });
      localStorage.setItem(_progressKey(), JSON.stringify({ seed: _questSeed, sectionId: currentSectionId, scores: scores, cargoScores: cargoScores, sectionCells: _sectionCells, visitedSections: _visitedSections, runnerScores: _runnerScores, scoredDice: _scoredDiceSections }));
    }
    function _loadProgress() {
      if (!chadId) return null;
      try { return JSON.parse(localStorage.getItem(_progressKey())); } catch(e) { return null; }
    }
    function _clearProgress() {
      if (!chadId) return;
      localStorage.removeItem(_progressKey());
    }
    var diceOutcomes = ${diceOutcomesJson};
    // Maps sectionId → { next1, next2 } for double-choice sections
    var doubleChoiceMap = ${doubleChoiceMapJson};
    // Maps sectionId → { gameFile, nextSectionId } for sections that embed a game
    var gameSectionMap = ${gameSectionMapJson};
    // Maps sectionId → { minigameFile, winNextSectionId } for minigame sections (win/loss branching)
    var minigameSectionMap = ${minigameSectionMapJson};
    // Maps sectionId → cells awarded to players who visit that section
    var sectionXpMap = ${sectionXpMapJson};
    // Tracks which branch the player chose (0 or 1) for the first two double-choice sections,
    // in encounter order. Passed as choice1/choice2 to QuestRewards.completeQuest.
    var _choiceRecord = [];
    var sectionMusic = ${sectionMusicJson};
    var introLines = ${introLinesJson};

    var musicMuted = false;
    var _currentMusicSrc = '';

    function playQuestMusic(sectionId) {
      var audio = document.getElementById('questBgMusic');
      if (!audio) return;
      var src = sectionId ? (sectionMusic[sectionId] || '') : '';
      _currentMusicSrc = src;
      if (!src || musicMuted) { audio.pause(); audio.src = ''; return; }
      if (audio.src.endsWith(src.replace('../../', ''))) return; // already playing
      audio.src = src;
      audio.volume = 0.3;
      audio.play().catch(function() {});
    }

    function toggleQuestMusic() {
      var btn = document.getElementById('musicToggleBtn');
      var audio = document.getElementById('questBgMusic');
      musicMuted = !musicMuted;
      if (musicMuted) {
        if (audio) { audio.pause(); }
        if (btn) { btn.textContent = '🔇'; btn.classList.add('muted'); btn.title = 'Unmute music'; }
      } else {
        if (btn) { btn.textContent = '♪'; btn.classList.remove('muted'); btn.title = 'Mute music'; }
        if (_currentMusicSrc && audio) {
          audio.src = _currentMusicSrc;
          audio.play().catch(function() {});
        }
      }
    }

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

function showPanel(id) {
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
      var panelId = id ? 'panel-' + id : 'panel-complete';
      var panel = document.getElementById(panelId);
      if (!panel) return;
      // Reset states for entrance animation
      var img = panel.querySelector('.section-img');
      var narrative = panel.querySelector('.narrative');
      var actionWrap = panel.querySelector('.action-wrap');
      var hudEl = id ? panel.querySelector('.quest-hud') : null;
      var diceSection = id ? panel.querySelector('.dice-section') : null;
      if (img) { img.style.transition = ''; img.style.opacity = '0'; }
      if (narrative) {
        narrative.style.transition = '';
        narrative.style.opacity = '0';
        narrative.classList.remove('typing');
        var old = narrative.querySelector('.typewriter-line');
        if (old) old.remove();
      }
      if (hudEl) {
        // Dice panel: keep action-wrap visible; reset HUD and dice section independently
        hudEl.style.transition = ''; hudEl.style.opacity = '0';
        if (diceSection) { diceSection.style.transition = ''; diceSection.style.opacity = '0'; }
        if (actionWrap) { actionWrap.style.transition = ''; actionWrap.style.opacity = '1'; actionWrap.style.pointerEvents = 'auto'; }
      } else {
        if (actionWrap) { actionWrap.style.transition = ''; actionWrap.style.opacity = '0'; actionWrap.style.pointerEvents = 'none'; }
      }
      panel.classList.add('active');
      // Show exp box only on non-game, non-complete panels
      var _isGameSec = id && (!!gameSectionMap[id] || !!minigameSectionMap[id]);
      // Fullscreen mode for minigame sections — class is added AFTER dialogue in animatePanel
      var _isMinigame = id && !!minigameSectionMap[id];
      if (!_isMinigame) document.body.classList.remove('minigame-active');
      var expBoxEl = document.getElementById('expBox');
      if (expBoxEl) expBoxEl.style.display = (id && !_isGameSec) ? 'block' : 'none';
      updateExpBox();
      playQuestMusic(id || null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      animatePanel(id || null);

      // Set game iframe src dynamically so tokenId/questId/player/worker params are injected at runtime
      if (id && gameSectionMap[id]) {
        var gFrame = panel.querySelector('.section-game-frame');
        if (gFrame && !gFrame.dataset.loaded) {
          var gp = new URLSearchParams();
          gp.set('tokenId', chadId || '');
          gp.set('questId', QUEST_ID);
          if (userAddress) gp.set('player', userAddress);
          if (WORKER_URL) gp.set('worker', WORKER_URL);
          gFrame.src = '../../games/' + gameSectionMap[id].gameFile + '?' + gp.toString();
          gFrame.dataset.loaded = '1';
        }
      }

      // Set minigame iframe src dynamically
      if (id && minigameSectionMap[id]) {
        var mgFrame = document.getElementById('minigameFrame_' + id);
        if (mgFrame && !mgFrame.dataset.loaded) {
          var mgp = new URLSearchParams();
          mgp.set('tokenId', chadId || '');
          mgp.set('questId', QUEST_ID);
          mgp.set('sectionId', id);
          if (userAddress) mgp.set('player', userAddress);
          if (WORKER_URL) mgp.set('worker', WORKER_URL);
          mgFrame.src = '../../games/' + minigameSectionMap[id].minigameFile + '?' + mgp.toString();
          mgFrame.dataset.loaded = '1';
          mgFrame.addEventListener('load', function() { _showMgTap(mgFrame); }, { once: true });
        } else if (mgFrame && mgFrame.dataset.loaded) {
          _showMgTap(mgFrame);
        }
      }

      // When reaching the complete panel, show total cells that will be claimed.
      // Use cargoScore (not totalScore) for dice sections — totalScore includes statBonusVal
      // per section, but the worker adds the stat bonus only ONCE globally on /session/win.
      // Summing totalScore across multiple dice sections would overcount the bonus.
      if (!id) {
        var _cellTotal = _sectionCells + _questRunnerXP + Object.keys(diceOutcomes).reduce(function(sum, sid) {
          return sum + ((diceState[Number(sid)] && diceState[Number(sid)].cargoScore) || 0);
        }, 0);
        var xpPreviewEl = document.getElementById('xpPreview');
        var xpPreviewVal = document.getElementById('xpPreviewValue');
        if (xpPreviewEl) {
          xpPreviewVal.textContent = _cellTotal;
          xpPreviewEl.style.display = 'block';
        }
      }
    }

    function goToSection(id) {
      // Record narrative choices for completeQuest (first two double-choice sections only)
      if (currentSectionId !== null && doubleChoiceMap[currentSectionId] && _choiceRecord.length < 2) {
        var dc = doubleChoiceMap[currentSectionId];
        _choiceRecord.push(id === dc.next1 ? 0 : 1);
      }
      currentSectionId = id || null;
      _saveProgress();
      showPanel(id || null);

      // Track section cells locally (once per section per session)
      if (id && sectionXpMap[id] !== undefined && !_visitedSections[id]) {
        _visitedSections[id] = true;
        _sectionCells += sectionXpMap[id];
        _saveProgress();
        updateExpBox();
      }

      // Report section visit to worker so section cells are tracked server-side
      if (id && sectionXpMap[id] !== undefined && WORKER_URL && chadId) {
        fetch(WORKER_URL + '/session/visit-section', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tokenId:   chadId,
            questId:   QUEST_ID,
            sectionId: id,
            sectionXp: sectionXpMap[id],
          }),
        }).catch(function() {});
      }
    }

    // ── Session & active status check ──────────────────────────────────────
    function _setStartEnabled(enabled) {
      var btn = document.getElementById('introStartBtn');
      if (!btn) return;
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.4';
      btn.style.pointerEvents = enabled ? 'auto' : 'none';
    }
    async function checkSessionStatus() {
      var statusEl  = document.getElementById('escrowStatus');
      var advBtn    = document.getElementById('goAdventureBtn');
      if (!statusEl) return;

      if (!QUEST_REWARDS_ADDRESS || !chadId) {
        // No contract configured — proceed without on-chain check
        if (statusEl) statusEl.style.display = 'none';
        if (advBtn)   advBtn.style.display   = 'none';
        _setStartEnabled(true);
        return;
      }

      statusEl.textContent = '⏳ Checking quest status…';
      try {
        var rp = _getReadProvider();
        var lc = new ethers.Contract(CONTRACT_ADDRESS, LASTCHAD_ABI, rp);
        var qr = new ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, rp);

        // Check if Chad is eliminated
        var isEliminated = await lc.eliminated(chadId);
        if (isEliminated) {
          statusEl.textContent = '💀 CHAD #' + chadId + ' has been eliminated';
          if (advBtn) advBtn.style.display = 'none';
          _setStartEnabled(false);
          return;
        }

        // Check if Chad has an active session (isActive flag on LastChad)
        var active = await lc.isActive(chadId);
        if (active) {
          statusEl.textContent = '✅ CHAD #' + chadId + ' has an active quest session';
          if (advBtn) advBtn.style.display = 'none';
          _setStartEnabled(true);
          return;
        }

        // Check quest cooldown
        var lastTime = await qr.lastQuestTime(chadId, QUEST_ID);
        var cooldown = await qr.questCooldown();
        var now = Math.floor(Date.now() / 1000);
        if (lastTime.toNumber() > 0 && now < lastTime.toNumber() + cooldown.toNumber()) {
          var remaining = (lastTime.toNumber() + cooldown.toNumber()) - now;
          var days = Math.ceil(remaining / 86400);
          statusEl.textContent = 'This Chad has already attempted the quest';
          if (advBtn) advBtn.style.display = 'none';
          _setStartEnabled(false);
          return;
        }

        // Not active — user must start quest from adventure/chadbase
        statusEl.textContent = '🔒 Start this quest from the Adventure page';
        if (advBtn) advBtn.style.display = '';
        _setStartEnabled(false);
      } catch(e) {
        // RPC error — don't block the player
        statusEl.textContent = '⚠️ Could not verify quest status (network error)';
        if (advBtn) advBtn.style.display = 'none';
        _setStartEnabled(true);
      }
    }

    // ────────────────────────────────────────────────────────────────────────

    function startQuest() {
      if (!chadId) { alert('Select your Chad NFT first.'); return; }
      var overlay = document.getElementById('intro-overlay');
      if (overlay) {
        overlay.classList.add('hidden');
        setTimeout(function() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 1300);
      }
      var firstId = ${sections.length > 0 ? sections[0].id : 'null'};

      // Resume saved session if one exists (prevents restarting mid-quest)
      var saved = _loadProgress();
      if (saved && !isQuestDone(chadId)) {
        if (saved.seed) _questSeed = saved.seed;
        if (saved.scores) {
          Object.keys(saved.scores).forEach(function(sid) {
            getDiceState(Number(sid)).totalScore = saved.scores[sid];
          });
        }
        if (saved.cargoScores) {
          Object.keys(saved.cargoScores).forEach(function(sid) {
            getDiceState(Number(sid)).cargoScore = saved.cargoScores[sid];
          });
        }
        if (saved.sectionCells) _sectionCells = saved.sectionCells;
        if (saved.visitedSections) _visitedSections = saved.visitedSections;
        if (saved.runnerScores) {
          _runnerScores = saved.runnerScores;
          // Rebuild HUD runner total from saved map
          Object.keys(_runnerScores).forEach(function(sid) { _questRunnerXP += _runnerScores[sid]; });
        }
        if (saved.scoredDice) _scoredDiceSections = saved.scoredDice;
        var resumeId = saved.sectionId || firstId;
        currentSectionId = resumeId;
        showPanel(resumeId);
        if (!_questSeed) _startOnChainQuest();
        return;
      }

      // Fresh start
      currentSectionId = firstId;
      _saveProgress();
      showPanel(firstId);
      _startOnChainQuest(); // fetch seed created by startQuest() on the adventure/chadbase page
    }

    async function animateIntro() {
      var introText = document.getElementById('introText');
      var startBtn = document.getElementById('introStartBtn');
      if (!introLines.length) {
        if (startBtn) { startBtn.style.opacity = '1'; startBtn.style.pointerEvents = 'auto'; }
        return;
      }
      function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
      introText.style.transition = 'opacity 0.5s ease';
      await wait(400);
      introText.style.opacity = '1';
      await wait(600);
      for (var li = 0; li < introLines.length; li++) {
        var line = introLines[li];
        var p = document.createElement('p');
        var cur = document.createElement('span');
        cur.className = 'typewriter-cursor';
        p.appendChild(cur);
        introText.appendChild(p);
        var typed = '';
        for (var ci = 0; ci < line.length; ci++) {
          typed += line[ci];
          p.textContent = typed;
          p.appendChild(cur);
          await wait(50);
        }
        cur.remove();
        if (li < introLines.length - 1) await wait(1500);
      }
      await wait(400);
      if (startBtn) {
        startBtn.style.transition = 'opacity 0.8s ease';
        startBtn.style.opacity = startBtn.disabled ? '0.4' : '1';
        startBtn.style.pointerEvents = startBtn.disabled ? 'none' : 'auto';
      }
    }

    // Known items: id -> display name (generated from builder-config.js)
    var knownItems = ${JSON.stringify(knownItems)};

    // Item images for HUD badges (generated from builder-config.js)
    var HUD_ITEM_DETAILS = ${JSON.stringify(
      _cfg && _cfg.knownItems
        ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.image).map(([id, v]) => [id, { image: v.image }]))
        : { '1': { image: 'https://lastchad.xyz/assets/docs_lobby/lobbybrochure.jpg' } }
    )};

    // Item stat modifiers: itemId -> { str, int, dex, cha } (generated from builder-config.js)
    var ITEM_MODIFIERS = ${JSON.stringify(
      _cfg && _cfg.knownItems
        ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.modifiers).map(([id, v]) => [id, v.modifiers]))
        : { '1': { str: 0, int: 1, dex: 0, cha: 0 } }
    )};

    // Item descriptions for popup (generated from builder-config.js)
    var ITEM_DESCRIPTIONS = ${JSON.stringify(
      _cfg && _cfg.knownItems
        ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.description).map(([id, v]) => [id, v.description]))
        : { '1': "A flash drive containing Cindy's proprietary code. Whoever carries it feels their mind sharpen." }
    )};

    async function loadQuestHUD(sid) {
      if (!chadId) return;
      var hudEl = document.getElementById('questHud_' + sid);
      if (!hudEl) return;

      // Portrait image
      var imgEl = document.getElementById('hudChadImg_' + sid);
      if (imgEl) imgEl.src = '../../assets/chads/framed/' + chadId + '.png';

      // Equipped items from localStorage (immediate, no network)
      var modStr = 0, modInt = 0, modDex = 0, modCha = 0;
      try {
        var saved = localStorage.getItem('lc_equipped_' + chadId);
        var slots = saved ? JSON.parse(saved) : [];
        var activeItems = slots.filter(Boolean);
        var itemsRow = document.getElementById('hudItemsRow_' + sid);
        if (itemsRow && activeItems.length > 0) {
          itemsRow.classList.add('has-items');
          activeItems.forEach(function(iid) {
            var badge = document.createElement('div');
            badge.className = 'hud-item-badge';
            badge.onclick = function() { showItemPopup(iid); };
            var details = HUD_ITEM_DETAILS[iid];
            if (details && details.image) {
              var im = document.createElement('img');
              im.src = details.image;
              im.alt = knownItems[iid] || ('Item #' + iid);
              badge.appendChild(im);
            }
            var span = document.createElement('span');
            span.textContent = knownItems[iid] || ('Item #' + iid);
            badge.appendChild(span);
            itemsRow.appendChild(badge);
            var mod = ITEM_MODIFIERS[iid] || {};
            modStr += (mod.str || 0);
            modInt += (mod.int || 0);
            modDex += (mod.dex || 0);
            modCha += (mod.cha || 0);
          });
        }
      } catch(ex) {}

      // Stats from chain (async)
      try {
        var readProvider = _getReadProvider();
        var lcContract = new ethers.Contract(CONTRACT_ADDRESS, LASTCHAD_ABI, readProvider);
        var statsResult = await lcContract.getStats(chadId);
        var baseStr = parseInt(statsResult.strength);
        var baseInt = parseInt(statsResult.intelligence);
        var baseDex = parseInt(statsResult.dexterity);
        var baseCha = parseInt(statsResult.charisma);
        function setStatEl(elId, base, mod) {
          var el = document.getElementById(elId);
          if (!el) return;
          el.textContent = '' + (base + mod);
          if (mod > 0) el.classList.add('boosted');
        }
        setStatEl('hudStr_' + sid, baseStr, modStr);
        setStatEl('hudInt_' + sid, baseInt, modInt);
        setStatEl('hudDex_' + sid, baseDex, modDex);
        setStatEl('hudCha_' + sid, baseCha, modCha);
        // _chadStats includes item mods — used for HUD display only
        window._chadStats = {
          strength: baseStr + modStr,
          intelligence: baseInt + modInt,
          dexterity: baseDex + modDex,
          charisma: baseCha + modCha
        };
        // _chadBaseStats is chain-only — used for dice XP scoring to match worker calculation
        window._chadBaseStats = {
          strength: baseStr,
          intelligence: baseInt,
          dexterity: baseDex,
          charisma: baseCha
        };
        var bonusEl = document.getElementById('statBonusVal_' + sid);
        if (bonusEl) {
          var stat = bonusEl.getAttribute('data-stat');
          bonusEl.textContent = '+' + (window._chadBaseStats[stat] || 0);
        }

        // Cells & level
        var level = await lcContract.getLevel(chadId);
        var openCells = await lcContract.getOpenCells(chadId);
        var closedCells = await lcContract.getClosedCells(chadId);
        var lvlEl = document.getElementById('hudLvl_' + sid);
        var openEl = document.getElementById('hudOpen_' + sid);
        var closedEl = document.getElementById('hudClosed_' + sid);
        if (lvlEl) lvlEl.textContent = level.toNumber();
        if (openEl) openEl.textContent = openCells.toNumber();
        if (closedEl) closedEl.textContent = closedCells.toNumber();
      } catch (e) {
        // HUD is cosmetic — silently fail if RPC unavailable
      }
    }

    function showItemPopup(iid) {
      var details = HUD_ITEM_DETAILS[iid] || {};
      var mod = ITEM_MODIFIERS[iid] || {};
      document.getElementById('itemPopupName').textContent = knownItems[iid] || ('Item #' + iid);
      document.getElementById('itemPopupDesc').textContent = ITEM_DESCRIPTIONS[iid] || '';
      var imgEl = document.getElementById('itemPopupImg');
      imgEl.src = details.image || '';
      imgEl.style.display = details.image ? 'block' : 'none';
      var bonuses = [];
      if (mod.str) bonuses.push('STR +' + mod.str);
      if (mod.int) bonuses.push('INT +' + mod.int);
      if (mod.dex) bonuses.push('DEX +' + mod.dex);
      if (mod.cha) bonuses.push('CHA +' + mod.cha);
      var statsEl = document.getElementById('itemPopupStats');
      statsEl.textContent = bonuses.join('   ');
      statsEl.style.display = bonuses.length ? 'block' : 'none';
      document.getElementById('itemPopupOverlay').classList.add('open');
    }

    function closeItemPopup() {
      document.getElementById('itemPopupOverlay').classList.remove('open');
    }

    document.getElementById('itemPopupOverlay').addEventListener('click', closeItemPopup);
    document.getElementById('itemPopup').addEventListener('click', function(e) { e.stopPropagation(); });
    document.getElementById('itemPopupClose').addEventListener('click', closeItemPopup);

    async function animatePanel(sid) {
      var panelId = sid ? 'panel-' + sid : 'panel-complete';
      var panel = document.getElementById(panelId);
      if (!panel) return;
      var gen = ++_animGen;
      function alive() { return gen === _animGen; }
      function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

      var img = panel.querySelector('.section-img');
      var narrative = panel.querySelector('.narrative');
      var actionWrap = panel.querySelector('.action-wrap');
      var hudEl = sid ? panel.querySelector('.quest-hud') : null;
      var diceSection = sid ? panel.querySelector('.dice-section') : null;

      // Collect plain-text lines from narrative <p> tags
      var lines = [];
      if (narrative) {
        narrative.querySelectorAll('p').forEach(function(p) {
          var text = p.textContent || p.innerText || '';
          if (text.trim()) lines.push(text.trim());
        });
      }

      // Step 1: fade in image
      if (img) {
        img.style.transition = 'opacity 1.6s ease';
        await wait(30);
        if (!alive()) return;
        img.style.opacity = '1';
        await wait(1800);
        if (!alive()) return;
      }

      // Step 2: fade in narrative container, then type lines
      if (narrative) {
        narrative.classList.add('typing');
        var tw = document.createElement('div');
        tw.className = 'typewriter-line';
        var cur = document.createElement('span');
        cur.className = 'typewriter-cursor';
        tw.appendChild(cur);
        narrative.insertBefore(tw, narrative.firstChild);

        narrative.style.transition = 'opacity 0.8s ease';
        await wait(20);
        if (!alive()) { tw.remove(); narrative.classList.remove('typing'); return; }
        narrative.style.opacity = '1';
        await wait(900);
        if (!alive()) { tw.remove(); narrative.classList.remove('typing'); return; }

        // Type each line — erase before the next, keep the last
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          tw.textContent = '';
          tw.appendChild(cur);
          var typed = '';
          for (var ci = 0; ci < line.length; ci++) {
            if (!alive()) { tw.remove(); narrative.classList.remove('typing'); return; }
            typed += line[ci];
            tw.textContent = typed;
            tw.appendChild(cur);
            await wait(60);
          }
          await wait(2300);
          if (!alive()) { tw.remove(); narrative.classList.remove('typing'); return; }
          if (li < lines.length - 1) {
            tw.textContent = '';
            tw.appendChild(cur);
            await wait(800);
            if (!alive()) { tw.remove(); narrative.classList.remove('typing'); return; }
          }
        }

        // Reveal original narrative HTML
        tw.remove();
        narrative.classList.remove('typing');
      }

      // Step 3: reveal action — dice panels sequence HUD then dice; others reveal action-wrap
      if (hudEl && diceSection) {
        // Step 3a: populate and fade in HUD
        await loadQuestHUD(sid);
        if (!alive()) return;
        hudEl.style.transition = 'opacity 1.0s ease';
        await wait(20);
        if (!alive()) return;
        hudEl.style.opacity = '1';
        await wait(1200);
        if (!alive()) return;
        // Step 3b: fade in dice game controls
        diceSection.style.transition = 'opacity 1.0s ease';
        await wait(20);
        if (!alive()) return;
        diceSection.style.opacity = '1';
      } else {
        // For minigame sections: activate fullscreen mode now that dialogue is done
        if (sid && minigameSectionMap[sid]) {
          document.body.classList.add('minigame-active');
          await wait(20);
          if (!alive()) return;
        }
        if (actionWrap) { actionWrap.style.transition = 'opacity 1.2s ease'; actionWrap.style.opacity = '1'; actionWrap.style.pointerEvents = 'auto'; }
      }
    }

    /* ===== DICE SYSTEM ===== */
    var diceState = {};

    function getDiceState(sid) {
      if (!diceState[sid]) {
        diceState[sid] = {
          values: [0, 0, 0, 0, 0],
          kept: [false, false, false, false, false],
          rollsLeft: 3,
          isRolling: false,
          kept1: 0,
          kept2: 0,
          totalScore: 0
        };
        for (var i = 0; i < 5; i++) {
          renderFace(i, 1, sid);
        }
      }
      return diceState[sid];
    }

    function toggleDie(idx, sid) {
      var state = getDiceState(sid);
      if (state.isRolling || state.values[idx] === 0) return;
      state.kept[idx] = !state.kept[idx];
      document.getElementById('die' + idx + '_' + sid).classList.toggle('kept', state.kept[idx]);
      var btn = document.getElementById('keep' + idx + '_' + sid);
      if (btn) {
        btn.classList.toggle('active', state.kept[idx]);
        btn.textContent = state.kept[idx] ? 'LOCKED' : 'LOCK';
      }
      updateChecklist(sid, false);
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
      var currentRoll = 3 - state.rollsLeft; // 1, 2, or 3

      // Snapshot kept bitmask before this roll (needed for QuestRewards.completeQuest)
      if (currentRoll === 2) {
        state.kept1 = 0;
        for (var ki = 0; ki < 5; ki++) { if (state.kept[ki]) state.kept1 |= (1 << ki); }
      } else if (currentRoll === 3) {
        state.kept2 = 0;
        for (var ki = 0; ki < 5; ki++) { if (state.kept[ki]) state.kept2 |= (1 << ki); }
      }

      // On-chain seed is mandatory — block roll until startQuest() confirms
      if (!_questSeed) {
        state.isRolling = false;
        state.rollsLeft++;
        var waitBtn = document.getElementById('rollBtn_' + sid);
        if (waitBtn) { waitBtn.textContent = 'AWAITING SEED'; waitBtn.disabled = false; }
        _startOnChainQuest();
        return;
      }

      // First roll: fade out section image, fade in HUD
      if (currentRoll === 1) {
        var panel = document.getElementById('panel-' + sid);
        if (panel) {
          var sImg = panel.querySelector('.section-img');
          var hudEl = document.getElementById('questHud_' + sid);
          if (sImg) {
            sImg.style.transition = 'opacity 0.4s ease';
            sImg.style.opacity = '0';
            setTimeout(function() { sImg.style.display = 'none'; }, 400);
          }
          if (hudEl) {
            hudEl.style.display = '';
            setTimeout(function() {
              hudEl.style.transition = 'opacity 0.5s ease';
              hudEl.style.opacity = '1';
            }, 50);
          }
        }
      }

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
        var finalValue = _deriveDieJS(_questSeed, currentRoll, dieIndex);
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
        updateChecklist(sid, true);
        finaliseDice(sid);
      } else {
        if (rollBtn) rollBtn.disabled = false;
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

      // Compute stat bonus first — it applies regardless of 6,5,4 outcome
      var statBonusVal = 0;
      if (outcome.statBonus && window._chadBaseStats) {
        // Use chain-only base stats to match worker calculation (item mods not honored server-side)
        statBonusVal = window._chadBaseStats[outcome.statBonus] || 0;
      }

      var vals = state.values.slice();
      var i6 = vals.indexOf(6);
      if (i6 === -1) { noScoreResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty, sid, statBonusVal); return; }
      vals.splice(i6, 1);
      var i5 = vals.indexOf(5);
      if (i5 === -1) { noScoreResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty, sid, statBonusVal); return; }
      vals.splice(i5, 1);
      var i4 = vals.indexOf(4);
      if (i4 === -1) { noScoreResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, outcome.failNextId, difficulty, sid, statBonusVal); return; }
      vals.splice(i4, 1);

      var score = vals[0] + vals[1];
      var total = score + statBonusVal;
      diceState[sid].cargoScore = score;
      diceState[sid].totalScore = total;

      // Record cargo score with worker immediately so it survives any later reload
      if (score > 0 && WORKER_URL && chadId && !_scoredDiceSections[sid]) {
        _scoredDiceSections[sid] = score;
        fetch(WORKER_URL + '/session/visit-section', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'dice_' + sid, sectionXp: score }),
        }).catch(function() {});
      }

      _saveProgress();
      updateExpBox();

      if (scoreBox) scoreBox.className = 'score-box scored';
      if (scoreLabel) scoreLabel.textContent = 'SCORE';
      if (scoreValue) {
        if (statBonusVal > 0) {
          var statShort = outcome.statBonus.slice(0, 3).toUpperCase();
          scoreValue.innerHTML = total + '<br><span style="color:#ff4444;font-size:0.6em">+' + statBonusVal + ' ' + statShort + '</span>';
        } else {
          scoreValue.textContent = total;
        }
      }

      if (total >= difficulty) {
        if (resultText) resultText.innerHTML = '<span class="result-success">SUCCESS</span>';
        if (continueWrap) continueWrap.classList.add('show');
        if (actionBtn) actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(outcome.passNextId);
      } else {
        if (scoreBox) scoreBox.className = 'score-box no-score';
        if (resultText) resultText.innerHTML = '<span class="result-fail">FAILURE</span>';
        if (continueWrap) continueWrap.classList.add('show');
        if (actionBtn) actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(outcome.failNextId);
      }
    }

    function noScoreResult(scoreBox, scoreLabel, scoreValue, resultText, continueWrap, actionBtn, failNextId, difficulty, sid, statBonusVal) {
      // Stat bonus still counts even when 6,5,4 aren't held
      var bonus = statBonusVal || 0;
      diceState[sid].cargoScore = 0;
      diceState[sid].totalScore = bonus;
      _saveProgress();
      updateExpBox();

      if (scoreBox) scoreBox.className = 'score-box no-score';
      if (scoreLabel) scoreLabel.textContent = 'NO SCORE';
      if (scoreValue) {
        if (bonus > 0) {
          var outcome = diceOutcomes[sid] || {};
          var statShort = (outcome.statBonus || '').slice(0, 3).toUpperCase();
          scoreValue.innerHTML = bonus + '<br><span style="color:#ff4444;font-size:0.6em">+' + bonus + ' ' + statShort + '</span>';
        } else {
          scoreValue.textContent = '0';
        }
      }
      if (resultText) resultText.innerHTML = '<span class="result-fail">FAILURE</span>';
      if (continueWrap) continueWrap.classList.add('show');
      if (actionBtn) {
        if (failNextId == null) {
          // No recovery path — quest failure means death
          actionBtn.onclick = function() { window.location.href = '../../died.html'; };
        } else {
          actionBtn.onclick = (function(nextId) { return function() { goToSection(nextId); }; })(failNextId);
        }
      }
    }

    // Initialise dice state + event listeners for each dice section
${diceInitJs}
    // Quest starts when the player clicks START on the intro overlay

    // ===== WALLET + ON-CHAIN INTEGRATION =====
    // CONTRACT_ADDRESS, QUEST_REWARDS_ADDRESS, ABIs, READ_RPC, etc. are loaded
    // from ../../js/quest-globals.js — update that file when contracts are redeployed.
    var QUEST_SLUG = '${sanitized}';
    var _cachedReadProvider = null;
    function _getReadProvider() {
      if (_cachedReadProvider) return _cachedReadProvider;
      var fuji = { chainId: 43113, name: 'fuji' };
      _cachedReadProvider = new ethers.providers.FallbackProvider([
        { provider: new ethers.providers.StaticJsonRpcProvider(READ_RPC, fuji), priority: 1, stallTimeout: 3000 },
        { provider: new ethers.providers.StaticJsonRpcProvider(READ_RPC_FALLBACK, fuji), priority: 2, stallTimeout: 3000 },
      ], 1);
      return _cachedReadProvider;
    }
    function _setText(el, text) {
      if (!el) return;
      el.textContent = text;
    }
    function _cleanRpcError(err) {
      // ethers v5: err.reason is the revert string, err.error?.data?.message has the VM reason
      var reason = err && err.reason;
      if (reason && reason !== 'unknown' && !reason.includes('CALL_EXCEPTION')) return String(reason).slice(0, 120);
      var nested = err && err.error && (err.error.reason || err.error.message || '');
      if (nested && !nested.includes('CALL_EXCEPTION')) return String(nested).slice(0, 120);
      var msg = err && (err.reason || err.message || '');
      if (!msg || msg.toLowerCase().includes('rpc request failed') || msg.toLowerCase().includes('request failed') || msg.toLowerCase().includes('network error') || msg.toLowerCase().includes('could not detect network')) {
        return 'Network error — RPC unavailable. Try again.';
      }
      // If only generic "call revert exception", try to extract the actual reason
      if (msg.includes('CALL_EXCEPTION') && err.errorArgs && err.errorArgs.length > 0) return String(err.errorArgs[0]).slice(0, 120);
      return String(msg).slice(0, 120);
    }
    var itemAwards = ${itemAwardsJson};
    var WORKER_URL = '${workerUrl}';
    var QUEST_ID = ${questId};
    var _questSeed = null; // set after startQuest confirmed on-chain

    // Mirror of QuestRewards._deriveDie: keccak256(seed, roll, dieIndex) % 6 + 1
    function _deriveDieJS(seed, roll, dieIndex) {
      var packed = ethers.utils.solidityPack(['bytes32', 'uint8', 'uint8'], [seed, roll, dieIndex]);
      return ethers.BigNumber.from(ethers.utils.keccak256(packed)).mod(6).toNumber() + 1;
    }

    // Fetch the on-chain seed after startQuest() confirms (seed is available immediately).
    // adventure.html already awaits tx.wait() before navigating here, so the first
    // fetch should succeed. Retry up to 5 times with 2-second backoff in case of RPC lag.
    var _seedFetchPending = false;

    async function _startOnChainQuest() {
      if (!QUEST_REWARDS_ADDRESS || !chadId) return;
      if (_seedFetchPending) return;
      _seedFetchPending = true;
      var attempts = 0;
      var MAX_ATTEMPTS = 5;
      var RETRY_MS = 2000;
      (async function fetchSeed() {
        try {
          var rp = _getReadProvider();
          var qrRead = new ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, rp);
          var session = await qrRead.getSession(chadId);
          // session[0] = seed (non-zero once startQuest has confirmed)
          if (session && session[0] !== ethers.constants.HashZero) {
            _questSeed = session[0];
            _seedFetchPending = false;
            _saveProgress();
            document.querySelectorAll('[id^="rollBtn_"]').forEach(function(btn) {
              if (btn.textContent === 'AWAITING SEED') { btn.textContent = 'ROLL'; btn.disabled = false; }
            });
            // Create the worker session so /session/win has a valid entry to sign against.
            // After start succeeds, replay any section visits that happened before the session existed.
            if (WORKER_URL && chadId && userAddress) {
              fetch(WORKER_URL + '/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, player: userAddress }),
              }).then(function(r) { return r.json(); }).then(function(startResp) {
                if (!startResp || !startResp.ok) return;
                // Replay all XP sources that occurred before (or after) the session was registered.
                // The worker deduplicates by sectionId so replaying is always safe.

                // 1. Regular section XP (sectionXpMap entries)
                Object.keys(_visitedSections).forEach(function(sid) {
                  if (sectionXpMap[sid] !== undefined) {
                    fetch(WORKER_URL + '/session/visit-section', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: sid, sectionXp: sectionXpMap[sid] }),
                    }).catch(function() {});
                  }
                });

                // 2. Runner minigame wins (keyed by runner section ID)
                Object.keys(_runnerScores).forEach(function(sid) {
                  fetch(WORKER_URL + '/session/visit-section', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'runner_' + sid, sectionXp: _runnerScores[sid] }),
                  }).catch(function() {});
                });

                // 3. Dice section cargo scores
                Object.keys(_scoredDiceSections).forEach(function(sid) {
                  fetch(WORKER_URL + '/session/visit-section', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'dice_' + sid, sectionXp: _scoredDiceSections[sid] }),
                  }).catch(function() {});
                });
              }).catch(function() {});
            }
            return;
          }
        } catch(e) { console.warn('Seed fetch failed:', e); }
        attempts++;
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(fetchSeed, RETRY_MS);
        } else {
          _seedFetchPending = false;
          console.error('Could not retrieve quest seed after ' + MAX_ATTEMPTS + ' attempts.');
        }
      })();
    }

    var walletProvider = null;
    var walletSigner = null;
    var userAddress = null;
    var chadId = null;

    // Read chad from URL param
    (function() {
      var p = new URLSearchParams(window.location.search);
      var c = p.get('chad');
      if (c && parseInt(c) > 0) chadId = parseInt(c);
    })();

    function truncateAddress(addr) { return addr.slice(0, 6) + '...' + addr.slice(-4); }

    function isMobile() { return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent); }

    async function switchToAvalanche(raw) {
      try {
        await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: AVAX_CHAIN_ID }] });
      } catch (err) {
        if (err.code === 4902) await raw.request({ method: 'wallet_addEthereumChain', params: [AVAX_CHAIN] });
        else throw err;
      }
    }

    function onConnected(addr) {
      userAddress = addr;
      document.getElementById('walletBtn').textContent = truncateAddress(addr);
      document.getElementById('walletBtn').classList.add('connected');
      closeWalletModal();
      checkQuestCompletion();
      checkSessionStatus();
      if (currentSectionId && !_questSeed) _startOnChainQuest();
    }

    function onDisconnected() {
      walletProvider = walletSigner = userAddress = null;
      document.getElementById('walletBtn').textContent = 'Connect Wallet';
      document.getElementById('walletBtn').classList.remove('connected');
      document.getElementById('disconnectDropdown').classList.remove('show');
    }

    async function connectInjected(name) {
      var raw = null;
      if (name === 'core' && (window.avalanche || (window.core && window.core.ethereum))) { raw = window.avalanche || window.core.ethereum; }
      else if (window.ethereum) {
        if (window.ethereum.providers && window.ethereum.providers.length) {
          for (var p of window.ethereum.providers) {
            if (name === 'rabby' && p.isRabby) { raw = p; break; }
            if (name === 'metamask' && p.isMetaMask && !p.isRabby) { raw = p; break; }
            if (name === 'core' && (p.isAvalanche || p.isCoreWallet)) { raw = p; break; }
          }
        }
        if (!raw) raw = window.ethereum;
      }
      if (!raw) { alert(name + ' wallet not detected.'); return; }
      try {
        var accounts = await raw.request({ method: 'eth_requestAccounts' });
        if (!accounts || accounts.length === 0) throw new Error('No accounts');
        await switchToAvalanche(raw);
        walletProvider = new ethers.providers.Web3Provider(raw);
        walletSigner = walletProvider.getSigner();
        onConnected(accounts[0]);
        raw.on('accountsChanged', function(accs) { if (accs.length === 0) onDisconnected(); else onConnected(accs[0]); });
        raw.on('chainChanged', function() { window.location.reload(); });
      } catch (err) { if (err.code !== 4001) alert('Connection failed: ' + (err.message || err)); }
    }

    function loadWcScript() {
      if (window.WalletConnectEthereumProvider) return Promise.resolve();
      return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = '../../assets/walletconnect-provider.js';
        s.onload = resolve; s.onerror = function() { reject(new Error('Failed to load WalletConnect')); };
        document.head.appendChild(s);
      });
    }

    async function connectWalletConnect() {
      try {
        await loadWcScript();
        var wc = await window.WalletConnectEthereumProvider.EthereumProvider.init({ projectId: WALLETCONNECT_PROJECT_ID, chains: [43113], showQrModal: true, rpcMap: { 43113: READ_RPC } });
        await wc.connect();
        walletProvider = new ethers.providers.Web3Provider(wc);
        walletSigner = walletProvider.getSigner();
        onConnected(await walletSigner.getAddress());
        wc.on('accountsChanged', function(accs) { if (accs.length === 0) onDisconnected(); else onConnected(accs[0]); });
        wc.on('disconnect', onDisconnected);
      } catch (err) { alert('WalletConnect failed. Please try again.'); }
    }

    async function connectWallet(name) {
      if (name === 'walletconnect') { await connectWalletConnect(); return; }
      await connectInjected(name);
    }

    // Wallet button events
    document.getElementById('walletBtn').addEventListener('click', function() {
      if (userAddress) { document.getElementById('disconnectDropdown').classList.toggle('show'); }
      else { openWalletModal(); }
    });
    document.getElementById('disconnectBtn').addEventListener('click', onDisconnected);
    document.addEventListener('wallet-selected', function(e) { connectWallet(e.detail.wallet); });
    document.addEventListener('click', function(e) { if (!e.target.closest('.wallet-wrapper')) document.getElementById('disconnectDropdown').classList.remove('show'); });


    // ===== QUEST COMPLETION TRACKING =====
    function getCompletionKey(tokenId) { return 'lc_q_' + QUEST_SLUG + '_' + tokenId; }
    function isQuestDone(tokenId) { return localStorage.getItem(getCompletionKey(tokenId)) === '1'; }
    function markQuestDone(tokenId) { localStorage.setItem(getCompletionKey(tokenId), '1'); }

    async function checkQuestCompletion() {
      var banner = document.getElementById('introCompletedBanner');
      var startBtn = document.getElementById('introStartBtn');

      if (!chadId) {
        _setStartEnabled(false);
        if (startBtn) startBtn.textContent = 'START';
        if (banner) banner.style.display = 'none';
        return;
      }

      // Fast local check first
      var done = isQuestDone(chadId);

      // On-chain check via QuestRewards (authoritative)
      if (!done && QUEST_REWARDS_ADDRESS) {
        try {
          var rp = _getReadProvider();
          var qr = new ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, rp);
          done = await qr.questCompleted(chadId, QUEST_ID);
          if (done) markQuestDone(chadId); // sync localStorage
        } catch(e) {}
      }

      if (done) {
        document.getElementById('introCompletedId').textContent = chadId;
        if (banner) banner.style.display = 'block';
        _setStartEnabled(false);
        if (startBtn) startBtn.textContent = 'COMPLETED';
      } else {
        if (banner) banner.style.display = 'none';
        // Don't enable here — checkSessionStatus() owns the enabled/disabled state
      }
    }


    // Run check on page load (using chadId from URL if present)
    checkQuestCompletion();
    animateIntro();
    checkSessionStatus();

    // Parent-side tap relay for WebView browsers (Rabby, MetaMask, etc.)
    // Sits above the iframe in the parent document — always receives first tap
    var _mgTapOverlay = document.getElementById('mg-tap-overlay');
    var _mgTapActive = false;
    function _showMgTap(frameEl) {
      // Hide parent loading screen — runner.html paints its own canvas "LOADING..." at
      // script execution time (before iframe 'load'), so there is no visual gap.
      var wrapEl = frameEl && frameEl.closest ? frameEl.closest('.minigame-fullscreen-wrap') : null;
      if (!wrapEl && frameEl) wrapEl = frameEl.parentElement;
      if (wrapEl) {
        var loadingEl = wrapEl.querySelector('.mg-loading-screen');
        if (loadingEl) loadingEl.classList.add('mg-hidden');
      }

      _mgTapActive = true;
      function _relayTap() {
        if (!_mgTapActive) return;
        _mgTapActive = false;
        _mgTapOverlay.style.display = 'none';
        if (frameEl && frameEl.contentWindow) {
          frameEl.contentWindow.postMessage({ type: 'parent_tap' }, '*');
        }
      }
      _mgTapOverlay.onclick = _relayTap;
      _mgTapOverlay.ontouchstart = function(e) { e.preventDefault(); _relayTap(); };
      _mgTapOverlay.onpointerdown = function(e) { e.preventDefault(); _relayTap(); };
    }
    function _hideMgTap() {
      _mgTapActive = false;
      _mgTapOverlay.style.display = 'none';
    }

    // Handle win/death messages from embedded game iframes
    var _runnerWinCert = null;
    var _minigameDeathHandled = false;
    window.addEventListener('message', function(e) {
      if (!e.data) return;

      // Win — advance to next section
      if (e.data.type === 'runner_win') {
        _hideMgTap();
        _runnerWinCert = null;
        if (e.data.runnerXP && Number(e.data.runnerXP) > 0) {
          var _rXP = Number(e.data.runnerXP);
          _questRunnerXP += _rXP;
          // Record by section ID so this can be replayed to the worker after a page reload
          if (currentSectionId != null) _runnerScores[currentSectionId] = _rXP;
        }
        _saveProgress();
        // Advance to next section: check minigame map first, then legacy game map
        if (currentSectionId && minigameSectionMap[currentSectionId]) {
          var winId = minigameSectionMap[currentSectionId].winNextSectionId;
          goToSection(winId || null);
        } else if (currentSectionId && gameSectionMap[currentSectionId]) {
          var nextId = gameSectionMap[currentSectionId].nextSectionId;
          goToSection(nextId || null);
        }
        return;
      }

      // Death — show parent death overlay, end quest, redirect to died page
      if (e.data.type === 'runner_death') {
        if (_minigameDeathHandled) return;
        _minigameDeathHandled = true;
        document.body.classList.remove('minigame-active');
        var overlay = document.getElementById('minigame-death-overlay');
        if (overlay) {
          overlay.classList.add('show');
          requestAnimationFrame(function() { overlay.classList.add('visible'); });
        }
        setTimeout(function() {
          window.location.href = '../../died.html';
        }, 3000);
      }
    });

    // Auto-reconnect wallet on page load
    (async function() {
      var raw = window.ethereum || window.avalanche;
      if (raw) {
        try {
          var accounts = await raw.request({ method: 'eth_accounts' });
          if (accounts && accounts.length > 0) {
            await switchToAvalanche(raw);
            walletProvider = new ethers.providers.Web3Provider(raw);
            walletSigner = walletProvider.getSigner();
            onConnected(accounts[0]);
          }
        } catch(e) {}
      }
    })();

    // ===== CLAIM CELLS =====
    async function claimQuestXP() {
      var btn = document.getElementById('claimXpBtn');
      var statusEl = document.getElementById('claimXpStatus');

      if (!userAddress) {
        openWalletModal();
        return;
      }

      if (!chadId) {
        statusEl.textContent = 'Add ?chad=TOKEN_ID to the URL to link your NFT.';
        return;
      }

      if (isQuestDone(chadId)) {
        statusEl.textContent = 'Cells already claimed for CHAD #' + chadId;
        btn.disabled = true;
        btn.textContent = 'ALREADY CLAIMED';
        var rw = document.getElementById('returnWrap');
        if (rw) rw.style.display = '';
        return;
      }

      btn.disabled = true;
      _setText(btn, 'CLAIMING...');
      statusEl.textContent = '';

      // Verify the caller owns the Chad and has an active session
      if (QUEST_REWARDS_ADDRESS) {
        try {
          var readProvider = _getReadProvider();
          var lcRead = new ethers.Contract(CONTRACT_ADDRESS, LASTCHAD_ABI, readProvider);
          var qrRead = new ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, readProvider);

          // Check if already completed
          var alreadyClaimed = await qrRead.questCompleted(chadId, QUEST_ID);
          if (alreadyClaimed) {
            markQuestDone(chadId);
            _clearProgress();
            _setText(statusEl, 'Cells already claimed for CHAD #' + chadId);
            btn.disabled = true;
            _setText(btn, 'ALREADY CLAIMED');
            var rw = document.getElementById('returnWrap');
            if (rw) rw.style.display = '';
            return;
          }

          // Check if Chad has an active quest session
          var isActive = await lcRead.isActive(chadId);
          if (!isActive) {
            // Check if session expired
            var expired = false;
            try { expired = await qrRead.isSessionExpired(chadId); } catch(e) {}
            if (expired) {
              _setText(statusEl, 'Quest session expired. Cells for this attempt cannot be claimed.');
            } else {
              _setText(statusEl, 'No active quest session. Begin from the Adventure page to start a quest.');
            }
            btn.disabled = true;
            _setText(btn, 'SESSION INACTIVE');
            return;
          }

          // Verify ownership
          var owner = await lcRead.ownerOf(chadId);
          if (owner.toLowerCase() !== userAddress.toLowerCase()) {
            _setText(statusEl, 'This wallet does not own CHAD #' + chadId);
            btn.disabled = false;
            _setText(btn, 'CLAIM REWARDS');
            return;
          }
        } catch(e) { /* check failed — proceed */ }
      }

      // Step 1: Get cells + signature from worker.
      var workerCells = null;
      var workerSig = null;
      if (WORKER_URL && chadId) {
        _setText(statusEl, 'CALCULATING CELLS...');
        try {
          // All XP sources (sections, runner, dice cargo) are already accumulated in the worker
          // via /session/visit-section calls made in real-time as they were earned.
          // Send diceXP: 0 — the worker just adds stat bonus once and returns the signed total.
          var winResp = await fetch(WORKER_URL + '/session/win', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, diceXP: 0 }),
          }).then(function(r) { return r.json(); });
          if (winResp && winResp.ok) {
            workerCells = winResp.xpAmount;
            workerSig   = winResp.signature;
          } else if (winResp && !winResp.ok) {
            btn.disabled = false;
            _setText(btn, 'CLAIM REWARDS');
            _setText(statusEl, 'Cell verification failed: ' + (winResp.reason || 'unknown'));
            return;
          }
        } catch(e) { /* worker unavailable — proceed without signed cells */ }
      }

      // Step 2: Award cells on-chain via QuestRewards if configured, otherwise localStorage only
      if (QUEST_REWARDS_ADDRESS && walletSigner) {
        _setText(statusEl, 'CONFIRM IN WALLET...');
        try {
          var _cellReward = workerCells != null ? workerCells : 0;
          var _oracleSig  = workerSig   != null ? workerSig   : '0x';
          var qr = new ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, walletSigner);
          var tx = await qr.completeQuest(chadId, QUEST_ID, _cellReward, _oracleSig);
          _setText(statusEl, 'CONFIRMING...');
          await tx.wait();
        } catch(e) {
          btn.disabled = false;
          _setText(btn, 'CLAIM REWARDS');
          _setText(statusEl, 'Failed: ' + (e.reason || e.message || String(e)));
          return;
        }
      }

      markQuestDone(chadId);
      _clearProgress();
      _setText(btn, 'REWARDS CLAIMED — CHAD #' + chadId);
      var cellMsg = workerCells != null ? (workerCells + ' cells awarded!') : (QUEST_REWARDS_ADDRESS ? 'Cells awarded on-chain!' : 'Score recorded locally (QuestRewards not deployed).');
      _setText(statusEl, cellMsg);
      var rw = document.getElementById('returnWrap');
      if (rw) rw.style.display = '';
      checkQuestCompletion();
    }

    // ===== SECTION ITEM CLAIM =====
    function revealSectionAction(sectionId) {
      var claimWrap = document.getElementById('itemClaimWrap_' + sectionId);
      var actionContent = document.getElementById('sectionAction_' + sectionId);
      if (claimWrap) claimWrap.style.display = 'none';
      if (actionContent) actionContent.style.display = 'block';
    }

    function skipItemClaim(sectionId) {
      revealSectionAction(sectionId);
    }

    async function claimSectionItem(sectionId) {
      var itemId = itemAwards[sectionId];
      if (!itemId) { revealSectionAction(sectionId); return; }

      var btn = document.getElementById('claimItemBtn_' + sectionId);
      var statusEl = document.getElementById('claimItemStatus_' + sectionId);

      if (!userAddress) {
        openWalletModal();
        return;
      }

      btn.disabled = true;
      _setText(btn, 'MINTING...');
      if (statusEl) statusEl.textContent = '';

      try {
        var itemsContract = new ethers.Contract(ITEMS_CONTRACT_ADDRESS, LASTCHAD_ITEMS_ABI, walletSigner);
        var itemInfo = await itemsContract.getItem(itemId);
        var price = itemInfo.price || itemInfo[3];
        var tx = await itemsContract.mint(itemId, 1, { value: price });
        if (statusEl) _setText(statusEl, 'CONFIRMING...');
        await tx.wait();
        _setText(btn, 'CLAIMED!');
        if (statusEl) _setText(statusEl, 'ITEM ADDED TO YOUR WALLET');
        setTimeout(function() { revealSectionAction(sectionId); }, 1200);
      } catch(err) {
        if (statusEl) _setText(statusEl, err.code === 4001 ? 'CANCELLED' : 'ERROR: ' + (err.reason || err.message || 'Failed'));
        btn.disabled = false;
        _setText(btn, 'CLAIM ITEM');
      }
    }
  <\/script>
<audio id="questBgMusic" loop></audio>
</body>
</html>`;
}
