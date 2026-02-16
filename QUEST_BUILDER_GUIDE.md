# 🎮 Quest Builder Guide

A visual, interactive quest creation tool with **live preview** and **one-click file generation**.

---

## ⚡ Quick Start

### 1. Open the Quest Builder

```bash
# Open in your browser (from the project root):
# file:///home/user/Last-Chad/quest-builder.html
```

Or just open `quest-builder.html` in your browser.

### 2. Fill In Your Quest

**Step 1: Quest Info**
- Enter quest name (e.g., "Episode One")
- Paste your quest structure (the logic from Create New Quest skill)

**Step 2: Parse Structure**
- Click "Parse Structure"
- Builder generates editors for each section

**Step 3: Fill Each Section**
- Write dialogue text
- Upload images (previews show in builder)
- Edit button labels
- See live preview on right

**Step 4: Generate Files**
- Click "Generate Files"
- HTML is ready to download/copy

**Step 5: Save Quest**
- Run: `node save-quest.js`
- Prompts you for quest name
- Copies HTML to correct folder
- Moves images to `/images/` folder
- Creates quest folder structure

---

## 📝 Detailed Workflow

### Phase 1: Prepare Your Structure

First, use the **Create New Quest skill** to define your quest logic:

```
Use New quest skill
Name, The Dragon's Hoard
```

Or manually write your structure:

```
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

### Phase 2: Open Quest Builder

Open `quest-builder.html` in your browser.

### Phase 3: Enter Quest Info

**Quest Name:** "The Dragon's Hoard"

**Quest Structure:**
```
1, a,b
2a, d
2b, a
3p, a
3f, a
4, a
```

Click "Parse Structure" → Builder generates section editors.

### Phase 4: Add Content to Each Section

For **Section 1**:
- **Dialogue:** "You stand before a great cave. A golden glow emanates from within..."
- **Image:** Upload `dragon.png` (preview appears)
- **Button A:** "Enter boldly"
- **Button B:** "Investigate cautiously"

For **Section 2a**:
- **Dialogue:** "A massive dragon blocks your path!"
- **Image:** Upload `dragon-battle.png`
- (Dice section - no buttons needed)

For **Section 2b**:
- **Dialogue:** "You search around the cave entrance..."
- **Image:** Upload `cave-entrance.png`
- **Button A:** "Continue forward"

For **Section 3p** (Pass):
- **Dialogue:** "You defeat the dragon and claim the treasure!"
- **Image:** Upload `treasure.png`
- **Button A:** "Return home"

For **Section 3f** (Fail):
- **Dialogue:** "The dragon overwhelms you! You flee in terror!"
- **Image:** Upload `dragon-roars.png`
- **Button A:** "Continue"

For **Section 4** (Ending):
- **Dialogue:** "Your adventure comes to an end."
- **Button A:** "Back to start"

### Phase 5: Live Preview

As you type:
- Right panel updates in real-time
- See how dialogue looks
- See how buttons appear
- See how images display
- Check section formatting

### Phase 6: Generate HTML

Click "Generate Files" button:
- HTML is generated with all your content
- Switch to "Export" tab
- Copy the HTML code

### Phase 7: Save Everything

Run the save script:

```bash
node save-quest.js
```

**Prompts:**
1. Quest name: `The Dragon's Hoard`
2. Path to HTML file: `/path/to/downloaded/file.html`
3. Image file paths: One at a time, press Enter to skip

**Creates:**
```
/quests/the-dragons-hoard/
├── the-dragons-hoard.html
└── images/
    ├── dragon.png
    ├── dragon-battle.png
    ├── cave-entrance.png
    ├── treasure.png
    └── dragon-roars.png
```

### Phase 8: Test & Deploy

1. Open the quest in browser:
   ```
   file:///home/user/Last-Chad/quests/the-dragons-hoard/the-dragons-hoard.html
   ```

2. Test all paths:
   - Click button A
   - Go back, click button B
   - Try dice rolls
   - Verify images load

3. Add to `enter.html`:
   ```html
   <a href="../quests/the-dragons-hoard/the-dragons-hoard.html">
       <button class="quest-button">🐉 The Dragon's Hoard</button>
   </a>
   ```

4. Push to GitHub:
   ```bash
   git add quests/the-dragons-hoard/
   git commit -m "Add The Dragon's Hoard quest"
   git push
   ```

---

## 🎯 Features

### Left Panel: Quest Editor

- **Quest Info Section**
  - Quest name input
  - Structure textarea (paste your logic)
  - Parse button
  - Section/endpoint counters

- **Section Editors** (Generated)
  - **For each section:**
    - Section ID display
    - Dialogue textarea (auto-updates preview)
    - Image file upload with preview
    - Button label inputs (if section has buttons)
    - Dice indicator (if section has dice)

### Right Panel: Live Preview

- **Preview Tab**
  - Real-time rendering of first section
  - Shows dialogue text
  - Shows image preview
  - Shows buttons as they'll appear
  - Shows dice visual for dice encounters
  - Styled exactly like the final quest

- **Export Tab**
  - Full HTML code generated
  - Copy to clipboard button
  - Ready to paste or download

### Action Buttons

- **Update Preview** - Refresh the preview (usually automatic)
- **Generate Files** - Create the HTML code

---

## 💡 Pro Tips

### 1. Structure First

Write your structure and parse it FIRST before adding dialogue:

```
1, a,b
2a, a
2b, a,b
3aa, a
3ab, a
4, a
```

This creates all section editors at once.

### 2. Image Naming

Use clear, descriptive image names:
- ❌ `img1.png`, `screenshot.jpg`
- ✅ `dragon-boss.png`, `treasure-room.jpg`

These names display as hints in the preview.

### 3. Dialogue Tips

Write dialogue that fits in the box:
- ✅ 1-3 sentences per section
- ❌ Long paragraphs (they'll overflow)

Short, punchy dialogue works best in the game aesthetic.

### 4. Button Labels

Keep button text SHORT and ACTION-ORIENTED:
- ✅ "Attack!", "Negotiate", "Run Away"
- ❌ "Click here to choose the first option"

### 5. Testing

After saving:
1. Open the HTML file
2. Test EVERY path (don't just test the "happy path")
3. Verify ALL images load
4. Check mobile layout (shrink browser window)

### 6. Iterating

Want to change something?
1. Update quest-builder.html
2. Click "Generate Files" again
3. Run `save-quest.js` (it overwrites)
4. Refresh in browser

No manual HTML editing needed!

---

## 🎲 Dice Roll Sections

When your section has `d` endpoint:

```
2a, d
```

The builder automatically:
- Recognizes it as a dice encounter
- Shows "🎲 Dice Roll Encounter" indicator
- Generates dice container in HTML
- Adds rolling mechanics
- Creates pass/fail paths (3p, 3f)

**In quest, dice work like:**
- 5 clickable dice
- Lock/unlock by clicking
- 3 rolls to get best combination
- Need 6 + 5 + 4 to win
- XP = remaining dice sum + dex bonus

---

## 📊 Section Numbering Examples

### Simple Branch
```
1, a,b
2a, a
2b, a
3, a
```
**Preview:** [1] splits → [2a] and [2b] → both go to [3]

### Combat with Dice
```
1, a
2, d
3p, a
3f, a
4, a
```
**Preview:** [1] → [2] with dice → [3p] or [3f] → [4]

### Deep Nesting
```
1, a,b
2a, a,b
2b, a
3aa, a
3ab, a
4, a
```
**Preview:** [1] → [2a/2b] → [3aa/3ab] → [4]

---

## 🖼️ Image Best Practices

### File Size
- Keep images < 500KB
- Use PNG or JPG
- Recommended: 300x200 to 500x350 pixels

### Placement
- Upload when creating section
- Preview shows in builder
- Final quest will display below dialogue

### Naming Convention
```
[section-name]-[description].png
```

Examples:
- `1-cave-entrance.png`
- `2a-dragon-boss.png`
- `3p-victory-treasure.png`

---

## ⚙️ Save Script Usage

```bash
node save-quest.js
```

**Interactive prompts:**

1. **Quest Name:**
   ```
   Quest name (e.g., Episode One): The Dragon's Hoard
   ```
   (Converts to slug: `the-dragons-hoard`)

2. **HTML File Path:**
   ```
   Path to your HTML file: /Users/username/Downloads/dragon.html
   ```
   (Copy-paste from your downloads folder)

3. **Image Files:**
   ```
   Image file path (or press Enter to skip): /Users/username/Pictures/dragon.png
   ✅ Copied: dragon.png

   Image file path (or press Enter to skip): /Users/username/Pictures/treasure.png
   ✅ Copied: treasure.png

   Image file path (or press Enter to skip):
   ```
   (Press Enter to finish)

**Output:**
```
============================================================
✨ Quest Created Successfully!

📁 Quest Location:
   /home/user/Last-Chad/quests/the-dragons-hoard

📄 Files Created:
   • /home/user/Last-Chad/quests/the-dragons-hoard/the-dragons-hoard.html
   • /home/user/Last-Chad/quests/the-dragons-hoard/images/dragon.png
   • /home/user/Last-Chad/quests/the-dragons-hoard/images/treasure.png

🚀 Next Steps:
   1. Open your quest in a browser
   2. Test all paths and interactions
   3. Add a link in enter.html to access your quest
============================================================
```

---

## 🐛 Troubleshooting

### Images Not Previewing in Builder

**Problem:** Upload button works but no preview shows

**Solution:** Make sure file is valid image format (PNG, JPG, GIF)

### "No sections yet" in Preview

**Problem:** Parsed structure but nothing appears on right

**Solution:** Click "Parse Structure" button - need to do this first

### HTML Downloads as Binary

**Problem:** File won't open as text

**Solution:** Save as `.html` file, not `.txt`

### Images Show as Broken Links

**Problem:** Images in quest show X icon

**Solution:** Check images are in `/images/` folder, filenames match exactly

### Button Navigation Doesn't Work

**Problem:** Clicking button stays on same section

**Solution:** Ensure structure was parsed correctly - button labels must match endpoints

---

## 📋 Complete Workflow Checklist

- [ ] Define quest structure (1,a,b / 2a,d / etc)
- [ ] Open `quest-builder.html`
- [ ] Enter quest name
- [ ] Paste structure
- [ ] Click "Parse Structure"
- [ ] Fill dialogue for each section
- [ ] Upload images for each section
- [ ] Edit button labels
- [ ] Review live preview on right
- [ ] Click "Generate Files"
- [ ] Copy HTML from Export tab
- [ ] Run `node save-quest.js`
- [ ] Answer prompts (quest name, HTML path, image paths)
- [ ] Verify files created in `/quests/[name]/`
- [ ] Open HTML in browser
- [ ] Test all paths work
- [ ] Test images load
- [ ] Test buttons navigate correctly
- [ ] Add link to `enter.html`
- [ ] Commit and push to GitHub

---

## 🎨 Styling Customization

The generated HTML uses classes from `styles.css`. You can customize by adding CSS:

```html
<!-- In your quest HTML, add in <style> tag: -->

.dialogue-text {
    color: #ffd700 !important;  /* Change text color */
    font-size: 1.2rem !important;
}

.quest-button {
    background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%) !important;
}
```

Common classes to override:
- `.quest-title` - Big quest name
- `.dialogue-box` - Text container
- `.dialogue-text` - Actual text
- `.quest-button` - Choice buttons
- `.die` - Dice appearance
- `.dice-container` - Dice layout

---

## 📚 Advanced: Manual Edits

After generating HTML, you can still manually edit:

1. **Add XP bonuses:**
   ```javascript
   function goToSection(sectionId) {
       if (sectionId === '2a') {
           questState.xpTotal += 10;  // Add 10 XP bonus
       }
       // ... rest of navigation
   }
   ```

2. **Change dice requirements:**
   ```javascript
   // Default: need 6+5+4
   // Change to: need 6+6+5
   const hasWinning = dice.filter(d => d === 6).length >= 2
                      && dice.includes(5);
   ```

3. **Add conditional logic:**
   ```javascript
   function goToSection(sectionId) {
       if (questState.stats.dexterity > 7 && sectionId === '2-test') {
           goToSection('3-skilled');  // Skip ahead if skilled
           return;
       }
       // ... normal navigation
   }
   ```

But quest-builder is designed to avoid this - most things should be configurable via the builder!

---

## 🚀 Next: Publish Your Quest

### Step 1: Add to enter.html

```html
<section class="quests-grid">
    <h2>Available Quests</h2>

    <!-- Existing quests -->
    <a href="quests/quest.html">
        <button class="quest-button">Classic Quest</button>
    </a>

    <!-- Your new quest -->
    <a href="quests/the-dragons-hoard/the-dragons-hoard.html">
        <button class="quest-button">🐉 The Dragon's Hoard</button>
    </a>
</section>
```

### Step 2: Update docs.html

Add info about your quest:

```html
<h3>🐉 The Dragon's Hoard</h3>
<p>A perilous journey into dragon territory. Choose your approach carefully!</p>
<p><strong>Paths:</strong> 2 (sneak or fight)</p>
<p><strong>XP Reward:</strong> 20-40</p>
```

### Step 3: Commit

```bash
git add quests/the-dragons-hoard/
git add enter.html docs.html
git commit -m "Add The Dragon's Hoard quest"
git push origin main
```

---

## 💬 Tips from Experience

1. **Write dialogue first** - It's the hardest part, so do it in the builder while inspired
2. **Test early** - Generate and test after 2-3 sections, not at the end
3. **Keep it short** - 4-6 sections is good for first quest
4. **Use images** - They make quests way more fun
5. **Iterate** - Save, test, update, rinse repeat
6. **Balance choices** - Make button A and B feel equally rewarding

---

## 🎉 You're Ready!

```
Open quest-builder.html → Fill in content → Click Generate → Run save-quest.js → Done!
```

No manual HTML editing, no copying files, no confusion about where things go.

**Happy quest building! 🎮✨**
