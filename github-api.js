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

function generateQuestHTML(questName, sections) {
  const sanitized = questName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

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
    <div class="header-title">⚔️ ${escapeHtml(questName)}</div>
    <div class="nav-menu" id="navMenu"></div>
  </div>

  <div class="main">
    <button class="back-btn" onclick="window.history.back()">← Back</button>
    <h1 class="quest-title">${escapeHtml(questName)}</h1>
    <div id="questContainer" class="loading">Loading quest...</div>
  </div>

  <script src="../../nav.js"><\/script>
  <script>
    // Strip image data from sections — images are served as files in /images/
    const questData = ${JSON.stringify({
      name: questName,
      sections: sections.map(({ photo, diceImage, ...rest }) => ({ ...rest, hasPhoto: !!photo, hasDiceImage: !!diceImage }))
    })};
    const sectionMap = {};
    let currentSectionId = null;

    function escapeHtml(text) {
      if (!text) return '';
      return String(text).replace(/[&<>"']/g, function(m) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m];
      });
    }

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
          <div class="section-name">\${escapeHtml(section.name)}</div>
      \`;

      if (section.hasPhoto) {
        html += \`<img src="images/\${section.id}.png" alt="\${escapeHtml(section.name)}" class="section-image visible">\`;
      }

      html += \`
          <div class="dialogue">\${escapeHtml(section.dialogue || 'No dialogue...')}</div>
      \`;

      if (section.selectedChoice === 'single') {
        const nextSection = findNextSection(section);
        html += \`
          <div class="choices">
            <button class="choice-btn" onclick="displaySection(\${nextSection ? nextSection.id : 'null'})">
              \${escapeHtml(section.buttonName || 'Continue')}
            </button>
          </div>
        \`;
      } else if (section.selectedChoice === 'double') {
        const next1 = findNextSection(section, 1);
        const next2 = findNextSection(section, 2);
        html += \`
          <div class="choices double-choices">
            <button class="choice-btn" onclick="displaySection(\${next1 ? next1.id : 'null'})">
              \${escapeHtml(section.button1Name || 'Choice A')}
            </button>
            <button class="choice-btn" onclick="displaySection(\${next2 ? next2.id : 'null'})">
              \${escapeHtml(section.button2Name || 'Choice B')}
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
