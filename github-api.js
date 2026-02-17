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

    const response = await fetch(url, options);

    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch (e) {
        error = { message: response.statusText };
      }
      const errorMsg = error.message || error.error || `GitHub API error: ${response.status}`;
      console.error(`❌ API Error (${method} ${path}):`, errorMsg);
      throw new Error(errorMsg);
    }

    return response.json();
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

  async publishQuest(questName, sections) {
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

      // Get current branch reference
      const branchRef = await this.getBranchRef();
      const latestCommitSha = branchRef.data.object.sha;

      // Get the commit tree
      const commit = await this.getCommit(latestCommitSha);
      const treeData = await this.getTree(commit.data.tree.sha, true);

      // Prepare tree items
      const treeItems = treeData.data.tree.map(item => ({
        path: item.path,
        mode: item.mode,
        type: item.type,
        sha: item.sha
      }));

      // Generate quest HTML
      const questHTML = generateQuestHTML(questName, sections);
      const htmlBlob = await this.createBlob(questHTML, 'utf-8');
      treeItems.push({
        path: `${questPath}/index.html`,
        mode: '100644',
        type: 'blob',
        sha: htmlBlob.data.sha
      });

      // Add quest data JSON
      const questDataBlob = await this.createBlob(
        JSON.stringify({ name: questName, sections }, null, 2),
        'utf-8'
      );
      treeItems.push({
        path: `${questPath}/data.json`,
        mode: '100644',
        type: 'blob',
        sha: questDataBlob.data.sha
      });

      // Process and add images
      for (const section of sections) {
        if (section.photo) {
          const imageParts = section.photo.split(',');
          const imageData = imageParts.length > 1 ? imageParts[1] : imageParts[0];
          if (!imageData) {
            console.warn(`⚠️ Invalid photo data for section ${section.id}`);
            continue;
          }
          const imageBlob = await this.createBlob(imageData, 'base64');
          treeItems.push({
            path: `${imagesPath}/${section.id}.png`,
            mode: '100644',
            type: 'blob',
            sha: imageBlob.data.sha
          });
        }

        if (section.diceImage) {
          const diceParts = section.diceImage.split(',');
          const diceData = diceParts.length > 1 ? diceParts[1] : diceParts[0];
          if (!diceData) {
            console.warn(`⚠️ Invalid dice image data for section ${section.id}`);
            continue;
          }
          const diceBlob = await this.createBlob(diceData, 'base64');
          treeItems.push({
            path: `${imagesPath}/dice-${section.id}.png`,
            mode: '100644',
            type: 'blob',
            sha: diceBlob.data.sha
          });
        }
      }

      // Create new tree
      const newTree = await this.createTree(treeItems, commit.data.tree.sha);

      // Create commit
      const newCommit = await this.createCommit(
        `Add quest: ${questName}\n\nPublished from Quest Builder`,
        newTree.data.sha,
        [latestCommitSha]
      );

      // Update branch reference
      await this.updateRef(newCommit.data.sha);

      console.log(`✅ Quest published successfully!`);

      return {
        success: true,
        message: `Quest "${questName}" published successfully!`,
        questUrl: `https://lastchad.xyz/quests/${sanitized}/`,
        questPath: `quests/${sanitized}`
      };
    } catch (error) {
      console.error('Error publishing quest:', error);
      throw error;
    }
  }
}

/**
 * Generate quest player HTML
 */
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
    const questData = ${JSON.stringify({ name: questName, sections })};
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
