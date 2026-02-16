#!/usr/bin/env node

/**
 * Create New Quest Skill
 *
 * Generates branching quest HTML pages for Last Chad
 * Usage: npx .claude/skills/create-new-quest.js "Quest Name" "quest-structure.txt"
 *
 * Structure notation:
 * 1, a,b           → Section 1 with 2 button options
 * 2a, a            → Section 2a with 1 button option
 * 3a, d            → Section 3a ends with dice roll
 * 4p, a            → Section 4p (pass path) with 1 button
 * 4f, a            → Section 4f (fail path) with 1 button
 * 4aa, a,b         → Subsection 4aa with 2 button options
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const questName = args[0];
const structureFile = args[1];

if (!questName) {
  console.error('❌ Usage: create-new-quest.js "Quest Name" [structure-file.txt]');
  console.error('\nExample: create-new-quest.js "Episode One" quest-structure.txt');
  process.exit(1);
}

// Create folder structure
const questSlug = questName.toLowerCase().replace(/\s+/g, '-');
const questDir = path.join(__dirname, '../../quests', questSlug);
const imagesDir = path.join(questDir, 'images');

if (!fs.existsSync(questDir)) {
  fs.mkdirSync(questDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log(`✅ Created quest directory: ${questDir}`);
  console.log(`✅ Created images directory: ${imagesDir}`);
} else {
  console.log(`⚠️  Quest directory already exists: ${questDir}`);
}

// Parse structure file if provided
let questStructure = {};
if (structureFile && fs.existsSync(structureFile)) {
  const content = fs.readFileSync(structureFile, 'utf-8');
  questStructure = parseQuestStructure(content);
  console.log(`✅ Parsed quest structure from ${structureFile}`);
}

// Generate base HTML template
const htmlContent = generateQuestHTML(questName, questStructure);
const htmlPath = path.join(questDir, `${questSlug}.html`);

fs.writeFileSync(htmlPath, htmlContent);
console.log(`\n✅ Created quest HTML: ${htmlPath}`);
console.log(`📁 Quest structure:`);
console.log(`   quests/${questSlug}/`);
console.log(`   ├── ${questSlug}.html`);
console.log(`   └── images/`);

/**
 * Parse quest structure notation into object
 * Format: "1, a,b" or "2a, a" or "3a, d" etc.
 */
function parseQuestStructure(content) {
  const structure = {};
  const lines = content.split('\n').filter(line => line.trim());

  lines.forEach(line => {
    const match = line.match(/^(\d+[a-z]*)\s*,\s*([a-z,d]+)\s*(.*)/);
    if (match) {
      const [, sectionId, endpoints, description] = match;
      structure[sectionId] = {
        endpoints: endpoints.split(',').map(e => e.trim()),
        description: description.trim()
      };
    }
  });

  return structure;
}

/**
 * Generate complete quest HTML
 */
function generateQuestHTML(questName, structure) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${questName} - Last Chad</title>
    <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../../nav.css">
    <link rel="stylesheet" href="../../styles.css">
    <style>
        body {
            background: linear-gradient(135deg, #2a1810 0%, #3b2a14 50%, #1a1410 100%);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            font-family: 'Press Start 2P', monospace;
            color: #c9a84c;
        }

        header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: rgba(10, 10, 15, 0.95);
            z-index: 1000;
            padding: 1rem 2rem;
            border-bottom: 2px solid #c9a84c;
        }

        main {
            flex: 1;
            padding-top: 80px;
            padding: 80px 2rem 2rem;
            max-width: 1200px;
            margin: 0 auto;
            width: 100%;
        }

        .quest-container {
            background: rgba(59, 42, 20, 0.8);
            border: 3px solid #c9a84c;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5),
                        inset 0 1px 0 rgba(255, 255, 255, 0.1);
        }

        .quest-title {
            font-size: clamp(1.5rem, 4vw, 2.5rem);
            color: #ffd700;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8),
                         0 0 10px rgba(255, 215, 0, 0.3);
            margin-bottom: 2rem;
            text-align: center;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .dialogue-box {
            background: rgba(20, 15, 10, 0.9);
            border: 2px solid #8b7355;
            padding: 1.5rem;
            margin-bottom: 2rem;
            min-height: 100px;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }

        .dialogue-text {
            font-size: clamp(0.8rem, 2vw, 1rem);
            line-height: 1.6;
            color: #e8d4b8;
        }

        .section {
            display: none;
            animation: fadeIn 0.3s ease-in;
        }

        .section.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .button-group {
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
            justify-content: center;
            margin-top: 2rem;
        }

        .quest-button {
            background: linear-gradient(135deg, #8b7355 0%, #5a4a3a 100%);
            border: 2px solid #c9a84c;
            color: #ffd700;
            padding: 1rem 2rem;
            font-family: 'Press Start 2P', monospace;
            font-size: clamp(0.6rem, 1.5vw, 0.9rem);
            cursor: pointer;
            text-transform: uppercase;
            transition: all 0.3s ease;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5),
                        inset 0 1px 0 rgba(255, 255, 255, 0.2);
            position: relative;
            overflow: hidden;
        }

        .quest-button:hover {
            background: linear-gradient(135deg, #a08060 0%, #6b5a4a 100%);
            box-shadow: 0 6px 12px rgba(0, 0, 0, 0.7),
                        0 0 15px rgba(201, 168, 76, 0.5),
                        inset 0 1px 0 rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }

        .quest-button:active {
            transform: translateY(0);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5),
                        inset 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        .dice-container {
            display: flex;
            justify-content: center;
            gap: 1rem;
            margin: 2rem 0;
            flex-wrap: wrap;
        }

        .die {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #d4af37 0%, #8b7355 100%);
            border: 2px solid #c9a84c;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2.5rem;
            color: #3b2a14;
            border-radius: 4px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
            cursor: pointer;
            transition: all 0.2s ease;
            font-weight: bold;
            user-select: none;
        }

        .die:hover {
            transform: scale(1.05);
            background: linear-gradient(135deg, #ffd700 0%, #a08060 100%);
        }

        .die.locked {
            background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%);
            border-color: #66bb6a;
            color: #fff;
        }

        .dice-info {
            text-align: center;
            margin-top: 1rem;
            font-size: clamp(0.6rem, 1vw, 0.8rem);
        }

        .roll-button {
            background: linear-gradient(135deg, #c9a84c 0%, #8b7355 100%);
            border: 2px solid #ffd700;
            color: #1a1410;
            padding: 1rem 2rem;
            font-family: 'Press Start 2P', monospace;
            font-size: clamp(0.7rem, 1.5vw, 0.9rem);
            cursor: pointer;
            text-transform: uppercase;
            font-weight: bold;
            transition: all 0.3s ease;
            margin-top: 1rem;
        }

        .roll-button:hover {
            background: linear-gradient(135deg, #ffd700 0%, #a08060 100%);
            box-shadow: 0 0 15px rgba(255, 215, 0, 0.6);
        }

        .section-number {
            text-align: center;
            color: #8b7355;
            font-size: 0.8rem;
            margin-bottom: 1rem;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .xp-display {
            background: rgba(76, 175, 80, 0.2);
            border: 2px solid #66bb6a;
            color: #66bb6a;
            padding: 1rem;
            text-align: center;
            margin-top: 2rem;
            font-size: clamp(0.8rem, 1.5vw, 1rem);
        }

        @media (max-width: 768px) {
            main {
                padding: 80px 1rem 1rem;
            }

            .quest-container {
                padding: 1.5rem;
            }

            .button-group {
                gap: 0.5rem;
            }

            .die {
                width: 60px;
                height: 60px;
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <header id="nav-container"></header>

    <main>
        <div class="quest-container">
            <h1 class="quest-title">${questName}</h1>

            <!-- SECTIONS GO HERE -->
            <!-- Example section structure:
            <div id="section-1" class="section active">
                <div class="section-number">Section 1</div>
                <div class="dialogue-box">
                    <div class="dialogue-text">Your dialogue goes here...</div>
                </div>
                <div class="button-group">
                    <button class="quest-button" onclick="goToSection('2a')">Option A</button>
                    <button class="quest-button" onclick="goToSection('2b')">Option B</button>
                </div>
            </div>
            -->

            <!-- DICE ROLL EXAMPLE:
            <div id="section-3a" class="section">
                <div class="section-number">Section 3a</div>
                <div class="dialogue-box">
                    <div class="dialogue-text">Roll the dice!</div>
                </div>
                <div class="dice-container" id="dice-3a"></div>
                <div class="dice-info">Click dice to lock. Roll button appears after 3 attempts.</div>
                <button class="roll-button" id="roll-btn-3a" style="display:none" onclick="submitRoll('3a')">Submit Roll</button>
            </div>
            -->

        </div>
    </main>

    <script src="../../walletconnect-provider.js"></script>
    <script src="../../nav.js"></script>
    <script>
        // Initialize navigation
        const navContainer = document.getElementById('nav-container');
        navContainer.innerHTML = getNavigation();

        // Quest state
        const questState = {
            currentSection: '1',
            xpTotal: 0,
            stats: {
                strength: 5,
                intelligence: 5,
                dexterity: 5,
                charisma: 5
            }
        };

        /**
         * Navigate to next section
         */
        function goToSection(sectionId) {
            const current = document.getElementById(\`section-\${questState.currentSection}\`);
            const next = document.getElementById(\`section-\${sectionId}\`);

            if (current) current.classList.remove('active');
            if (next) {
                next.classList.add('active');
                questState.currentSection = sectionId;
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        /**
         * Roll dice for encounter
         */
        function rollDice(count = 5) {
            const dice = [];
            for (let i = 0; i < count; i++) {
                dice.push(Math.floor(Math.random() * 6) + 1);
            }
            return dice;
        }

        /**
         * Initialize dice roller for section
         */
        function initDiceRoller(sectionId, numDice = 5) {
            const container = document.getElementById(\`dice-\${sectionId}\`);
            if (!container) return;

            let rolls = 0;
            const maxRolls = 3;
            let currentDice = [];
            let lockedDice = new Set();

            function renderDice() {
                container.innerHTML = '';
                currentDice.forEach((value, index) => {
                    const die = document.createElement('div');
                    die.className = \`die \${lockedDice.has(index) ? 'locked' : ''}\`;
                    die.textContent = value;
                    die.onclick = () => toggleLock(index);
                    container.appendChild(die);
                });
            }

            function toggleLock(index) {
                if (rolls < maxRolls) {
                    if (lockedDice.has(index)) {
                        lockedDice.delete(index);
                    } else {
                        lockedDice.add(index);
                    }
                    renderDice();
                }
            }

            function roll() {
                if (rolls < maxRolls) {
                    rolls++;
                    currentDice = currentDice.map((val, idx) =>
                        lockedDice.has(idx) ? val : (Math.floor(Math.random() * 6) + 1)
                    );
                    renderDice();

                    if (rolls >= maxRolls) {
                        document.getElementById(\`roll-btn-\${sectionId}\`).style.display = 'block';
                    }
                }
            }

            window[\`roll_\${sectionId}\`] = roll;
            currentDice = rollDice(numDice);
            renderDice();

            // Initial roll button
            const rollBtn = document.getElementById(\`roll-btn-\${sectionId}\`);
            if (rollBtn) {
                rollBtn.onclick = () => roll();
                rollBtn.textContent = 'Roll Dice';
            }
        }

        /**
         * Submit dice roll and calculate result
         */
        function submitRoll(sectionId) {
            const dice = Array.from(document.querySelectorAll(\`#dice-\${sectionId} .die\`))
                .map(el => parseInt(el.textContent));

            // Check for winning combo: 6, 5, 4
            const hasWinning = dice.includes(6) && dice.includes(5) && dice.includes(4);

            if (hasWinning) {
                // Pass: Calculate XP
                const remaining = dice.filter(d => d !== 6 && d !== 5 && d !== 4);
                const baseXP = remaining.reduce((a, b) => a + b, 0);
                const dexBonus = Math.max(0, questState.stats.dexterity - 1);
                const totalXP = baseXP + dexBonus;

                questState.xpTotal += totalXP;
                goToSection(\`\${parseInt(sectionId[0]) + 1}p\`);
            } else {
                // Fail path
                goToSection(\`\${parseInt(sectionId[0]) + 1}f\`);
            }

            updateXPDisplay();
        }

        /**
         * Display accumulated XP
         */
        function updateXPDisplay() {
            const xpDisplay = document.querySelector('.xp-display');
            if (xpDisplay) {
                xpDisplay.innerHTML = \`⭐ XP Earned: <strong>\${questState.xpTotal}</strong> ⭐\`;
            }
        }

        // Show initial section
        document.addEventListener('DOMContentLoaded', () => {
            goToSection('1');
            updateXPDisplay();
        });
    </script>
</body>
</html>`;
}

console.log('\n📖 Quest created! Next steps:');
console.log('   1. Edit the HTML to add your sections and dialogue');
console.log('   2. Add quest images to the images/ folder');
console.log('   3. Reference images in dialogue: <img src="images/image-name.png">');
console.log('   4. Use goToSection() for buttons, initDiceRoller() for dice');
