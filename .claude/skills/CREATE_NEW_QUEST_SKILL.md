# 🎮 Create New Quest Skill

A specialized skill for generating branching narrative quest HTML pages for **Last Chad** RPG with support for:
- Dialogue sequences (one line at a time)
- Multiple button choices
- Deterministic dice rolls (pass/fail)
- XP reward calculations
- Section-based branching logic

---

## Usage

### Basic Usage

```
Use New quest skill
Name, Episode One
```

This will:
1. Create folder: `/quests/episode-one/`
2. Create HTML file: `/quests/episode-one/episode-one.html`
3. Create images folder: `/quests/episode-one/images/`

### Full Usage with Structure

```
Use New quest skill
Name, Episode One
Structure:
1, a,b
2a, a,b
2b, a
3, a
```

---

## Quest Structure Notation

### Section Naming

Sections are numbered with optional letter branches to represent dialogue flow:

| Notation | Meaning |
|----------|---------|
| `1` | Main section 1 |
| `2a` | Section 2, branch "a" |
| `2b` | Section 2, branch "b" |
| `3aa` | Subsection within 3a |
| `4p` | Section 4, pass path (from dice roll) |
| `4f` | Section 4, fail path (from dice roll) |

### Endpoint Types

The second part of each line defines what ends the section:

| Notation | Meaning | UI |
|----------|---------|-----|
| `1, a` | Single button "A" | One button to proceed |
| `1, a,b` | Two options | Two buttons (A and B) |
| `1, a,b,c` | Three options | Three buttons |
| `1, d` | Dice roll | 5 dice + Roll button |

### Button Behavior

- **`a, b, c` buttons** → Navigate to next section (`goToSection('2a')`)
- **`d` dice roll** → Calculate pass/fail, navigate to `[n]p` or `[n]f` section

---

## Examples

### Example 1: Linear Quest (No Branching)

```
Structure:
1, a
2, a
3, a
4, a
```

**Flow:**
```
[1] → [2] → [3] → [4] (end)
```

---

### Example 2: Two-Path Branching

```
Structure:
1, a,b
2a, a
2b, a,b
3a, a
3b, a
4, a
```

**Flow:**
```
     [1]
    /   \
  [2a]  [2b]
   |    /  \
  [3a] [3b_a] [3b_b]
    \    |    /
      \ [3] /
       \   /
       [4]
```

---

### Example 3: Dice Roll Quest

```
Structure:
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

**Flow:**
```
     [1]
    /   \
 [2a]   [2b]
  |      |
  |      |
[2a-roll]|
  / \    |
[3p] [3f]|
  \  |  /
   \ | /
    [4]
```

---

### Example 4: Complex Nested Quest

```
Structure:
1, a,b,c
2a, d
2b, a,b
2c, a
3p, a
3f, a
3ba, a
3bb, a,b
4aa, a
4bb, a
5, a
```

**Flow:**
```
Multiple branching paths with dice rolls and nested choices
[1] splits into [2a], [2b], [2c]
[2a] has dice roll → [3p] or [3f]
[2b] splits into [3ba] and [3bb]
[3bb] splits into [4aa] and [4bb]
All converge at [5]
```

---

## After Quest Creation

### 1. Add Dialogue & Sections

Edit the generated HTML and add your sections between the markers:

```html
<!-- SECTIONS GO HERE -->

<div id="section-1" class="section active">
    <div class="section-number">Section 1</div>
    <div class="dialogue-box">
        <div class="dialogue-text">Welcome, brave adventurer!</div>
    </div>
    <div class="button-group">
        <button class="quest-button" onclick="goToSection('2a')">Join the quest</button>
        <button class="quest-button" onclick="goToSection('2b')">Decline</button>
    </div>
</div>

<div id="section-2a" class="section">
    <div class="section-number">Section 2a</div>
    <div class="dialogue-box">
        <div class="dialogue-text">You accept the quest!</div>
    </div>
    <div class="button-group">
        <button class="quest-button" onclick="goToSection('3')">Continue</button>
    </div>
</div>

<!-- More sections... -->
```

### 2. Add Dice Roll Sections

```html
<div id="section-3a" class="section">
    <div class="section-number">Section 3a - Battle!</div>
    <div class="dialogue-box">
        <div class="dialogue-text">A wild enemy appears! Roll for combat!</div>
    </div>
    <div class="dice-container" id="dice-3a"></div>
    <div class="dice-info">
        🎲 Lock dice by clicking them. You have 3 rolls.
        <br/>Need 6 + 5 + 4 to win!
    </div>
    <button class="roll-button" id="roll-btn-3a" style="display:none"
            onclick="submitRoll('3a')">Submit Roll</button>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            initDiceRoller('3a', 5);
        });
    </script>
</div>
```

### 3. Initialize Dice Rollers on Page Load

```html
<script>
document.addEventListener('DOMContentLoaded', () => {
    initDiceRoller('2a', 5);  // 5 dice for section 2a
    initDiceRoller('3a', 5);  // 5 dice for section 3a
    // etc.
});
</script>
```

### 4. Add Images

Place images in `/quests/episode-one/images/` and reference them:

```html
<div class="dialogue-box">
    <img src="images/villain.png" style="max-width: 200px; margin-bottom: 1rem;">
    <div class="dialogue-text">An evil sorcerer blocks your path!</div>
</div>
```

---

## Styling & Customization

### Available CSS Classes

```css
.quest-container      /* Main quest box */
.quest-title          /* Big quest name */
.dialogue-box         /* Text/image display */
.dialogue-text        /* Actual dialogue */
.section              /* Each numbered section */
.section-number       /* "Section 3a" label */
.button-group         /* Container for buttons */
.quest-button         /* Choice buttons */
.dice-container       /* 5 dice grid */
.die                  /* Individual die (clickable) */
.die.locked           /* Locked die (green) */
.xp-display           /* XP earned display */
```

### Custom Styling Example

```html
<style>
    .dialogue-box {
        background: linear-gradient(135deg, #1a1410 0%, #3b2a14 100%);
        border: 3px solid #8b7355;
    }

    .dialogue-text {
        font-size: 1.2rem;
        color: #ffd700;
    }
</style>
```

---

## XP Calculation Logic

Dice rolls use the same system as `game.html`:

```javascript
// Requirements to win
const hasWinning = dice.includes(6) && dice.includes(5) && dice.includes(4);

// If true:
const remaining = dice.filter(d => d !== 6 && d !== 5 && d !== 4);
const baseXP = remaining.reduce((a, b) => a + b, 0);  // 2-12 XP
const dexBonus = Math.max(0, questState.stats.dexterity - 1);
const totalXP = baseXP + dexBonus;

// If false: No XP awarded
```

### Adding Choice Bonuses

You can add bonuses based on dialogue choices:

```javascript
function goToSection(sectionId) {
    // Add XP for choosing specific paths
    if (sectionId === '2a') {
        questState.xpTotal += 10;  // Bonus for brave choice
    }
    if (sectionId === '2b') {
        questState.xpTotal += 5;   // Smaller bonus for cautious choice
    }

    // Original navigation
    const current = document.getElementById(`section-${questState.currentSection}`);
    const next = document.getElementById(`section-${sectionId}`);
    if (current) current.classList.remove('active');
    if (next) {
        next.classList.add('active');
        questState.currentSection = sectionId;
    }
}
```

---

## Quest File Structure

```
/quests/
├── episode-one/
│   ├── episode-one.html        (generated HTML page)
│   └── images/
│       ├── villain.png
│       ├── forest.jpg
│       └── boss.png
├── episode-two/
│   ├── episode-two.html
│   └── images/
│       ├── npc.png
│       └── treasure.jpg
└── ...
```

---

## Tips & Tricks

### 1. Progressive Dialogue (One Line at a Time)

```html
<div class="dialogue-box" id="dialogue-1">
    <div class="dialogue-text">Part 1 of the story...</div>
</div>

<script>
// Advance dialogue within a section
let dialogueStep = 1;
const dialogues = [
    "You wake up in a dark forest.",
    "Strange shadows move between the trees.",
    "You hear a voice calling your name..."
];

function nextDialogue() {
    if (dialogueStep < dialogues.length) {
        document.getElementById('dialogue-1').innerHTML =
            `<div class="dialogue-text">${dialogues[dialogueStep]}</div>`;
        dialogueStep++;
    }
}
</script>
```

### 2. Stat-Based Outcomes

```javascript
function goToSection(sectionId) {
    // Different paths based on character stats
    if (sectionId === '2-insight' && questState.stats.intelligence > 7) {
        goToSection('3-genius');  // Smart character path
    } else if (sectionId === '2-strength' && questState.stats.strength > 7) {
        goToSection('3-fighter');  // Strong character path
    } else {
        goToSection('3-normal');   // Default path
    }
}
```

### 3. Conditional XP

```javascript
function submitRoll(sectionId) {
    // ... dice roll logic ...

    if (hasWinning) {
        const remaining = dice.filter(d => d !== 6 && d !== 5 && d !== 4);
        let totalXP = remaining.reduce((a, b) => a + b, 0);

        // Dexterity scaling
        totalXP += Math.max(0, questState.stats.dexterity - 1);

        // Path multipliers
        if (questState.currentSection === '2a') {
            totalXP *= 1.5;  // Hard mode bonus
        }

        questState.xpTotal += Math.round(totalXP);
    }
}
```

### 4. Multi-Step Dice Encounters

```html
<div id="section-3a" class="section">
    <div class="dialogue-box">
        <div class="dialogue-text">Combat Round 1: Avoid the trap!</div>
    </div>
    <div class="dice-container" id="dice-3a"></div>
    <button class="roll-button" id="roll-btn-3a" style="display:none"
            onclick="roundTwoDice('3a')">Continue to Round 2</button>
</div>

<div id="section-3b" class="section">
    <div class="dialogue-box">
        <div class="dialogue-text">Combat Round 2: Attack the enemy!</div>
    </div>
    <div class="dice-container" id="dice-3b"></div>
    <button class="roll-button" id="roll-btn-3b" style="display:none"
            onclick="submitRoll('3b')">Finish Battle</button>
</div>
```

---

## Common Patterns

### Pattern: Converging Paths
Multiple section branches merge back into one:

```
1, a,b
2a, a
2b, a
3, a  ← Both 2a and 2b navigate here
```

### Pattern: Nested Branching
Deep branching within a section branch:

```
1, a,b
2a, a
2b, a,b
3ba, a
3bb, a,b
4aa, a
4ab, a
5, a
```

### Pattern: Locked Paths
High stat requirements unlock special paths:

```
1, a,b
2a, (check dexterity)
  → if DEX > 7: go to 3-sneak
  → else: go to 3-normal
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Buttons not working | Check `onclick="goToSection('id')"` matches section ID |
| Dice not appearing | Ensure `initDiceRoller('2a', 5)` called in script |
| Missing styles | Verify `<link rel="stylesheet" href="../../styles.css">` |
| Images not loading | Check path: `images/filename.png` from HTML location |
| XP not updating | Call `updateXPDisplay()` after changing `questState.xpTotal` |

---

## FAQ

**Q: Can I have more than 5 dice?**
A: Yes! Change `initDiceRoller('2a', 7)` for 7 dice.

**Q: Can I skip the 6+5+4 requirement?**
A: Yes, modify the `submitRoll()` function to use custom logic.

**Q: How do I make choices award XP?**
A: Add `questState.xpTotal += amount;` in `goToSection()`.

**Q: Can sections loop back?**
A: Yes, use `goToSection('1')` to return to start, but avoid infinite loops!

**Q: How do I add NPCs/characters?**
A: Add an image and speaker name above dialogue:

```html
<div class="dialogue-box">
    <img src="images/npc.png" style="max-width: 100px; border-radius: 50%;">
    <strong style="color: #ffd700;">Wise Elder:</strong>
    <div class="dialogue-text">Beware the path ahead...</div>
</div>
```

---

## Ready to Create!

```bash
# You're ready to use:
Use New quest skill
Name, Your Quest Name

# Then paste your structure outline!
```

Happy quest making! 🎮✨
