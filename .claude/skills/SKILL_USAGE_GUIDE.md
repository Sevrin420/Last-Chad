# 🎯 Create New Quest Skill - Usage Guide

## Quick Start

In any Claude Code session, use the skill like this:

```
Use New quest skill
Name, Episode One
```

Claude will:
1. ✅ Create `/quests/episode-one/` directory
2. ✅ Create `/quests/episode-one/episode-one.html` template
3. ✅ Create `/quests/episode-one/images/` folder for assets
4. ✅ Display instructions for next steps

---

## Complete Workflow

### Step 1: Describe Your Quest Structure

```
Use New quest skill
Name, The Dragon's Hoard

Structure:
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

### Step 2: Claude Generates The Quest File

The skill creates a fully-styled HTML page with:
- All sections marked as placeholders
- Styling matching your Last Chad game theme
- Dice rolling mechanics ready to go
- XP tracking system built-in
- Navigation menu integrated

### Step 3: Add Your Content

Edit the generated HTML file to add:

**Dialogue:**
```html
<div id="section-1" class="section active">
    <div class="section-number">Section 1</div>
    <div class="dialogue-box">
        <div class="dialogue-text">You stand at the mouth of a great cave...</div>
    </div>
    <div class="button-group">
        <button class="quest-button" onclick="goToSection('2a')">Enter boldly</button>
        <button class="quest-button" onclick="goToSection('2b')">Proceed carefully</button>
    </div>
</div>
```

**Dice Encounters:**
```html
<div id="section-2a" class="section">
    <div class="section-number">Section 2a - Battle!</div>
    <div class="dialogue-box">
        <div class="dialogue-text">A dragon guards the treasure!</div>
    </div>
    <div class="dice-container" id="dice-2a"></div>
    <button class="roll-button" id="roll-btn-2a" style="display:none"
            onclick="submitRoll('2a')">Submit Roll</button>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            initDiceRoller('2a', 5);
        });
    </script>
</div>
```

**Images:**
```html
<div class="dialogue-box">
    <img src="images/dragon.png" style="max-width: 300px;">
    <div class="dialogue-text">The dragon roars!</div>
</div>
```

### Step 4: Add Images to Quest Folder

```
/quests/episode-one/images/
├── dragon.png
├── treasure.jpg
├── knight.png
└── forest.jpg
```

---

## Structure Notation Reference

### Anatomy of a Line

```
SECTION_ID, ENDPOINTS [optional description]
```

### Section Naming Examples

```
1            → Main starting section
2a           → Branch from button 'a' in section 2
2b           → Branch from button 'b' in section 2
3aa          → Sub-branch from 'a' in section 3a
4p           → Pass path from section 4 dice roll
4f           → Fail path from section 4 dice roll
```

### Endpoint Types

```
a            → Single button to continue
a,b          → Two choice buttons
a,b,c        → Three choice buttons
d            → Dice roll (pass/fail paths follow)
```

### Real Examples

**Linear Quest (No Choices):**
```
1, a
2, a
3, a
4, a
```

**Two-Path Quest:**
```
1, a,b
2a, a
2b, a
3, a
```

**Dice Quest:**
```
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

**Complex Nested:**
```
1, a,b,c
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
```

---

## Code Examples

### Basic Button Navigation

```html
<button class="quest-button" onclick="goToSection('2a')">
    Choose Path A
</button>
```

### Dice Roller Setup

```html
<!-- HTML -->
<div class="dialogue-box">
    <div class="dialogue-text">Roll for initiative!</div>
</div>
<div class="dice-container" id="dice-3a"></div>
<button class="roll-button" id="roll-btn-3a" style="display:none"
        onclick="submitRoll('3a')">Submit Roll</button>

<!-- JavaScript -->
<script>
document.addEventListener('DOMContentLoaded', () => {
    initDiceRoller('3a', 5);  // 5 dice
});
</script>
```

### Adding XP Bonuses

```javascript
function goToSection(sectionId) {
    // Award XP for choosing brave path
    if (sectionId === '2a') {
        questState.xpTotal += 15;
    }

    // Navigate normally
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

### Multi-Choice with Images

```html
<div id="section-1" class="section active">
    <div class="section-number">Section 1 - The Crossroads</div>
    <div class="dialogue-box">
        <img src="images/crossroads.png" style="max-width: 300px; margin-bottom: 1rem;">
        <div class="dialogue-text">Three paths lie before you...</div>
    </div>
    <div class="button-group">
        <button class="quest-button" onclick="goToSection('2a')">North - Mountain Path</button>
        <button class="quest-button" onclick="goToSection('2b')">East - Forest Path</button>
        <button class="quest-button" onclick="goToSection('2c')">South - River Path</button>
    </div>
</div>
```

### Stat-Based Outcomes

```javascript
function goToSection(sectionId) {
    // Branch based on character stats
    if (sectionId === '2-test' && questState.stats.dexterity > 7) {
        goToSection('3-dodge');  // Skilled dodge
    } else if (sectionId === '2-test' && questState.stats.strength > 7) {
        goToSection('3-overpower');  // Brute force
    } else {
        goToSection('3-normal');  // Default outcome
    }

    updateXPDisplay();
}
```

---

## File Organization

After running the skill:

```
Last-Chad/
├── quests/
│   ├── episode-one/
│   │   ├── episode-one.html     ← Edit this!
│   │   └── images/
│   │       ├── villain.png
│   │       ├── forest.jpg
│   │       └── treasure.png
│   ├── episode-two/
│   │   ├── episode-two.html
│   │   └── images/
│   └── ...
├── game.html
├── quest.html
├── ...
└── styles.css                   ← Shared styles
```

---

## Styling Deep Dive

### Default Classes Available

```css
.quest-container       /* Main quest box with border */
.quest-title           /* Large quest name header */
.section-number        /* "Section 2a" label */
.dialogue-box          /* Container for text + images */
.dialogue-text         /* Actual story text */
.button-group          /* Container for choice buttons */
.quest-button          /* Gold 3D buttons */
.quest-button:hover    /* Button hover state */
.dice-container        /* Grid of 5 dice */
.die                   /* Individual die */
.die.locked            /* Locked die (green) */
.roll-button           /* Roll submission button */
.xp-display            /* XP earned display */
```

### Custom Styling

```html
<style>
    /* Override defaults */
    .dialogue-text {
        font-size: 1.3rem;
        color: #ffd700;
        font-weight: bold;
    }

    /* Add new styles */
    .npc-name {
        color: #c9a84c;
        font-size: 1rem;
        margin-bottom: 0.5rem;
        text-transform: uppercase;
        letter-spacing: 2px;
    }

    /* Customize dice */
    .die {
        width: 100px;
        height: 100px;
        font-size: 3rem;
    }
</style>
```

---

## Advanced Patterns

### Pattern 1: Typewriter Dialogue

```javascript
const text = "Hello, brave adventurer...";
let index = 0;

function typeWrite() {
    const element = document.getElementById('dialogue-1');
    if (index < text.length) {
        element.textContent += text[index];
        index++;
        setTimeout(typeWrite, 50);  // 50ms per character
    }
}

// Call: typeWrite()
```

### Pattern 2: Converging Paths

```
1, a,b
2a, d
2b, a
3p, a   ← Both can lead here
3b, a   ←
4, a    ← Final convergence
```

In HTML:
```html
<!-- From 2a (after dice) -->
<button class="quest-button" onclick="goToSection('4')">Continue</button>

<!-- From 2b -->
<button class="quest-button" onclick="goToSection('4')">Continue</button>
```

### Pattern 3: Branching Dice

```
1, a,b
2a, d      ← Different dice paths
2b, d      ←
3p, a,b    ← Pass outcomes
3f, a,b    ← Fail outcomes
5, a
```

### Pattern 4: Secret Paths

```javascript
function goToSection(sectionId) {
    // Hidden path if player has certain stat
    if (sectionId === '2' && questState.stats.intelligence > 8) {
        // Skip to secret section
        goToSection('secret');
    }

    // Normal navigation
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

## Testing Your Quest

### 1. Open in Browser
```bash
# From project root
# Open: file:///home/user/Last-Chad/quests/episode-one/episode-one.html
```

### 2. Test All Paths
- [ ] Button A path works
- [ ] Button B path works
- [ ] Dice rolls correctly
- [ ] Pass/fail paths work
- [ ] XP displays update
- [ ] Images load properly
- [ ] Styles look good on mobile

### 3. Check Console for Errors
- F12 → Console tab
- No red errors should appear

---

## Common Issues & Fixes

| Problem | Solution |
|---------|----------|
| Buttons don't work | Check: `onclick="goToSection('2a')"` matches section ID exactly |
| Section doesn't appear | Verify: `<div id="section-2a" class="section">` |
| Dice missing | Check: `initDiceRoller('3a', 5);` in script tag |
| Images not showing | Verify: `src="images/filename.png"` (path relative to HTML file) |
| Styles look wrong | Check: `<link rel="stylesheet" href="../../styles.css">` |
| Mobile looks broken | Use `clamp()` for font sizes, avoid fixed widths |
| XP not updating | Call: `updateXPDisplay();` after changing XP |

---

## Publishing Your Quest

### 1. Add Link to enter.html

Edit `enter.html` and add:

```html
<a href="../quests/episode-one/episode-one.html" class="quest-link">
    <button class="quest-button">Episode One</button>
</a>
```

### 2. Add to docs.html

Update documentation with your new quest:

```html
<h3>Episode One: The Dragon's Hoard</h3>
<p>A classic branching quest with dice combat.
   Three paths to victory, one way to lose!</p>
```

### 3. Push to GitHub

```bash
git add quests/episode-one/
git commit -m "Add Episode One quest"
git push origin claude/create-landing-page-1qjhB
```

---

## API Reference

### Global Functions

```javascript
// Navigate to section
goToSection('2a');

// Initialize dice for section
initDiceRoller('3a', 5);  // 5 dice

// Submit roll and calculate result
submitRoll('3a');

// Update XP display
updateXPDisplay();

// Roll dice (returns array)
const dice = rollDice(5);  // [3, 5, 2, 6, 1]
```

### Quest State Object

```javascript
questState = {
    currentSection: '1',
    xpTotal: 0,
    stats: {
        strength: 5,
        intelligence: 5,
        dexterity: 5,
        charisma: 5
    }
}

// Usage:
questState.xpTotal += 20;
if (questState.stats.dexterity > 7) { ... }
```

---

## Tips for Great Quests

✨ **Make it immersive:**
- Add atmospheric images
- Use descriptive dialogue
- React to player choices

🎮 **Balance gameplay:**
- Mix combat and decisions
- Multiple viable paths
- Meaningful rewards

📖 **Tell a story:**
- Character arcs
- Plot twists
- Memorable NPCs

🎲 **Use dice wisely:**
- Don't overuse dice rolls
- Make them feel risky
- Clear win/loss conditions

---

## Next Steps

1. **Create your quest:** `Use New quest skill`
2. **Add dialogue:** Edit the HTML sections
3. **Add images:** Place in `/images/` folder
4. **Test thoroughly:** Verify all paths work
5. **Publish:** Add links to main pages

---

**Happy quest creating! 🎮✨**

For detailed examples, see `CREATE_NEW_QUEST_SKILL.md`
