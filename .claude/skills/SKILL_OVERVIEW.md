# 🎮 Create New Quest Skill - Overview

## What Is This Skill?

The **Create New Quest** skill generates fully-functional branching quest HTML pages for Last Chad RPG. You provide the story structure, it generates the interactive web page with:

✅ Styled dialogue boxes
✅ Interactive button choices
✅ Deterministic dice rolls (pass/fail)
✅ XP calculation and tracking
✅ Responsive design matching your game theme
✅ Ready-to-edit template

---

## How It Works

### Input: Quest Structure Notation

```
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

### Processing: Generates Files

```
/quests/episode-one/
├── episode-one.html    ← Fully-styled interactive page
└── images/            ← For your quest artwork
```

### Output: Playable Quest

- Opening dialogue with 2 choices
- Branch A leads to dice combat
- Branch B leads to simple decision
- Pass/Fail paths from dice roll
- Final convergence and ending

---

## Structure Notation Explained

### The Format

```
SECTION_ID, ENDPOINTS
```

**SECTION_ID** = Where you are in the story
- `1` = Starting section
- `2a` = Path from choosing option A
- `2b` = Path from choosing option B
- `3p` = After passing a dice roll
- `3f` = After failing a dice roll
- `4aa` = Nested branch within 4a

**ENDPOINTS** = What happens at the end of the section
- `a` = One button to continue
- `a,b` = Two choice buttons
- `a,b,c` = Three choice buttons
- `d` = Dice roll (leads to pass/fail paths)

---

## Visual Flow Examples

### Example 1: Simple Linear Quest

```
Structure:    1, a → 2, a → 3, a → 4, a

Visual:       [1] → [2] → [3] → [4]
                ↓
           Continue
```

### Example 2: Two-Path Quest

```
Structure:    1, a,b
              2a, a
              2b, a
              3, a

Visual:       [1]
             /   \
           A      B
          /        \
        [2a]      [2b]
         |         |
        [3] ←←← (converge)
```

### Example 3: Combat Quest

```
Structure:    1, a,b
              2a, d
              2b, a
              3p, a
              3f, a
              4, a

Visual:       [1]
             /   \
           A      B
          /        \
       [2a]       [2b]
        |           |
       DICE         |
       / \          |
    PASS FAIL       |
    [3p] [3f]       |
      \   /         /
      [4] ←←←←←←←
```

### Example 4: Complex Nested

```
Structure:    1, a,b,c
              2a, d
              2b, a,b
              2c, a
              3p, a
              3f, a
              3ba, a
              3bb, a,b
              4aa, a
              4ab, a
              5, a

Visual:       Multiple branching paths with convergence
              Deep nesting of choices
              Different outcomes based on decisions
```

---

## Usage Flow

### Step 1: Run the Skill

```
In Claude Code, type:

Use New quest skill
Name, Episode One
```

### Step 2: Provide Structure

Claude asks for your quest structure:

```
1, a,b
2a, d
2b, a,b
3p, a
3f, a
3ba, a
3bb, a,b
4, a
```

### Step 3: Files Are Generated

```
✅ Created: /quests/episode-one/episode-one.html
✅ Created: /quests/episode-one/images/ folder
✅ Generated: Full HTML template with styling
```

### Step 4: Edit Content

You add:
- Dialogue text
- Button labels
- Images
- Custom styling

---

## Quick Code Reference

### Navigating Between Sections

```html
<button class="quest-button" onclick="goToSection('2a')">
    Accept the quest
</button>
```

### Dice Roll Encounter

```html
<div class="dice-container" id="dice-3a"></div>
<button class="roll-button" id="roll-btn-3a" style="display:none"
        onclick="submitRoll('3a')">Submit Roll</button>

<script>
document.addEventListener('DOMContentLoaded', () => {
    initDiceRoller('3a', 5);  // 5 dice
});
</script>
```

### Adding Dialogue with Image

```html
<div id="section-1" class="section active">
    <div class="dialogue-box">
        <img src="images/npc.png" style="max-width: 200px;">
        <div class="dialogue-text">
            Greetings, adventurer!
        </div>
    </div>
    <div class="button-group">
        <button class="quest-button" onclick="goToSection('2a')">Listen</button>
        <button class="quest-button" onclick="goToSection('2b')">Leave</button>
    </div>
</div>
```

### Award XP for Choices

```javascript
function goToSection(sectionId) {
    // Award XP for brave path
    if (sectionId === '2a') {
        questState.xpTotal += 20;
    }

    // Navigate
    const current = document.getElementById(`section-${questState.currentSection}`);
    const next = document.getElementById(`section-${sectionId}`);

    if (current) current.classList.remove('active');
    if (next) {
        next.classList.add('active');
        questState.currentSection = sectionId;
        updateXPDisplay();
    }
}
```

---

## File Structure

After creating a quest:

```
Last-Chad/
├── .claude/
│   ├── skills/
│   │   ├── create-new-quest.js              ← The generator script
│   │   ├── CREATE_NEW_QUEST_SKILL.md        ← Full documentation
│   │   ├── SKILL_USAGE_GUIDE.md            ← Practical guide
│   │   └── quest-template.txt              ← Structure examples
│   │
│   └── hooks/
│       └── session-start.sh                ← Project info on startup
│
├── quests/                                 ← New quests folder
│   ├── episode-one/
│   │   ├── episode-one.html               ← Edit this! Your quest page
│   │   └── images/
│   │       ├── villain.png
│   │       ├── forest.jpg
│   │       └── treasure.png
│   │
│   ├── episode-two/
│   │   ├── episode-two.html
│   │   └── images/
│   │
│   └── ...more quests...
│
├── game.html                              ← Dice minigame
├── quest.html                             ← Original quest page
├── stats.html                             ← Character stats
├── styles.css                             ← Shared styles
└── ...
```

---

## Key Features

### 🎨 Pre-Styled

- Medieval gold/bronze theme
- 3D beveled buttons
- Responsive design (mobile-friendly)
- Matches Last Chad aesthetic
- Customizable CSS classes

### 🎲 Dice Mechanics

- 5 clickable dice (lock/unlock)
- 3 rolls per encounter
- Pass/fail scoring (need 6+5+4)
- XP calculation with stat bonuses
- Deterministic (same inputs = same result)

### 📖 Dialogue System

- One section at a time
- Multiple choice buttons
- Progressive story flow
- NPC support with images
- Text customization

### 🎯 XP Rewards

- Base XP from dice rolls
- Bonus XP for clever choices
- Dexterity scaling
- Stat-based path branching
- Real-time tracking

### 🔧 Fully Customizable

- Edit all dialogue
- Add/change images
- Modify button labels
- Create nested branches
- Add special effects

---

## Real Quest Example

### Structure

```
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

### Flow

```
You find a locked door.

[1] Do you:
    → [a] Pick the lock? (risky)  → 2a (dice roll)
    → [b] Search for key? (safe)  → 2b (simple)

[2a] Roll to pick the lock
    → [pass] Success! You're in   → 3p
    → [fail] Alarm triggers!      → 3f

[2b] You find a key under the mat → 3

[3p] You find treasure inside!    → 4 (ending)
[3f] Guards arrive!               → 4 (ending)
[3]  You open the door slowly...  → 4 (ending)

[4] Quest complete!
```

---

## When to Use This Skill

✅ **Use this skill when:**
- Creating new quests for your game
- Designing branching storylines
- Adding combat encounters (dice rolls)
- Building multiple-choice scenarios
- Structuring narrative paths

❌ **Don't use for:**
- Editing existing quest.html
- Modifying game mechanics
- Changing core contracts
- Editing HTML pages directly (use Claude instead)

---

## Getting Started

### 1. Open Your Project

```bash
cd /home/user/Last-Chad
# Open Claude Code session
```

### 2. Use the Skill

```
Use New quest skill
Name, The Goblin's Gold
```

### 3. Provide Your Structure

```
1, a,b
2a, d
2b, a,b
3p, a
3f, a
3ba, a
3bb, a,b
4, a
```

### 4. Edit the Generated HTML

- Add dialogue to each section
- Add images to `/images/` folder
- Reference images in HTML
- Test in browser

### 5. Link It Into Your Game

Add button to `enter.html`:

```html
<a href="../quests/the-goblins-gold/the-goblins-gold.html">
    <button class="quest-button">The Goblin's Gold</button>
</a>
```

---

## Tips for Success

🎯 **Start simple:** Create 3-section quest first
📊 **Test thoroughly:** Try all paths
🎨 **Add visuals:** Images make quests memorable
📈 **Balance XP:** Make rewards feel earned
🎭 **Tell stories:** Dialogue matters more than mechanics
🔄 **Iterate:** Update based on feedback

---

## Still Have Questions?

📖 **For detailed documentation:** See `CREATE_NEW_QUEST_SKILL.md`
🚀 **For step-by-step guide:** See `SKILL_USAGE_GUIDE.md`
📋 **For structure examples:** See `quest-template.txt`

---

**You're ready to create amazing quests! 🎮✨**

Type: `Use New quest skill` and start building!
