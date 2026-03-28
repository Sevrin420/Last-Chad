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
      console.error(`❌ Network Error (${method} ${path}):`, err.message, err);
      console.error(`   Token length: ${this.token.length}, starts: ${this.token.substring(0, 8)}...`);
      throw new Error(`Network error: ${err.message}\n(Request: ${method} ${url})`);
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
      const baseTreeSha = commit.tree.sha;
      const treeData = await this.getTree(baseTreeSha, true);
      console.log(`✓ Tree fetched with ${treeData.tree.length} existing items`);

      // Only track NEW/CHANGED files — base_tree handles the rest
      const treeItems = [];

      // Read quest index first to assign a stable on-chain questId
      progress('Updating quest manifest...');
      const indexJsonItem = treeData.tree.find(item => item.path === 'quests/index.json');
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
      const newTree = await this.createTree(treeItems, baseTreeSha);
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
  // sectionMusic built above — used by questDataJson

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
  // itemAwards built above — used by questDataJson

  const introLines = introDialogue
    ? introDialogue.split('\n').map(l => l.trim()).filter(Boolean)
    : [];
  // introLines built above — used by questDataJson

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

  // diceOutcomes, doubleChoiceMap built above — used by questDataJson

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
  // gameSectionMap built above — used by questDataJson

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
  // minigameSectionMap built above — used by questDataJson

  // Map sectionId → cells awarded when player enters that section (tracked server-side)
  const sectionXpMap = {};
  sections.forEach(s => {
    if (s.sectionXp && Number(s.sectionXp) > 0) sectionXpMap[s.id] = Number(s.sectionXp);
  });
  // sectionXpMap built above — used by questDataJson

  // Build QUEST_DATA JSON for the slim template
  const questDataJson = JSON.stringify({
    diceOutcomes: diceOutcomes,
    doubleChoiceMap: doubleChoiceMap,
    gameSectionMap: gameSectionMap,
    minigameSectionMap: minigameSectionMap,
    sectionXpMap: sectionXpMap,
    sectionMusic: sectionMusic,
    introLines: introLines,
    knownItems: knownItems,
    hudItemDetails: _cfg && _cfg.knownItems
      ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.image).map(([id, v]) => [id, { image: v.image }]))
      : { '1': { image: 'https://lastchad.xyz/assets/docs_lobby/lobbybrochure.jpg' } },
    itemModifiers: _cfg && _cfg.knownItems
      ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.modifiers).map(([id, v]) => [id, v.modifiers]))
      : { '1': { str: 0, int: 1, dex: 0, cha: 0 } },
    itemDescriptions: _cfg && _cfg.knownItems
      ? Object.fromEntries(Object.entries(_cfg.knownItems).filter(([,v]) => v.description).map(([id, v]) => [id, v.description]))
      : { '1': "A flash drive containing Cindy's proprietary code. Whoever carries it feels their mind sharpen." },
    itemAwards: itemAwards,
    questSlug: sanitized,
    workerUrl: workerUrl,
    questId: questId,
    questMeta: {
      name: questName,
      sections: sections.map(({ photo, diceImage, ...rest }) => ({ ...rest, hasPhoto: !!photo, hasDiceImage: !!diceImage }))
    },
    firstSectionId: sections.length > 0 ? sections[0].id : null,
    diceInitIds: sections.filter(s => s.selectedChoice === 'dice').map(s => s.id),
  }).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(questName)} | Last Chad</title>
  <link rel="stylesheet" href="../../styles.css">
  <link rel="stylesheet" href="../../nav.css">
  <link rel="stylesheet" href="../../css/quest.css">
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
  <script>var QUEST_DATA = ${questDataJson};<\/script>
  <script src="../../js/quest-engine.js"><\/script>
<audio id="questBgMusic" loop></audio>
</body>
</html>`;
}
