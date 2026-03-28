// ============================================================
// Quest Engine — shared runtime for all generated quest pages
// Requires: window.QUEST_DATA defined before this script loads
// Requires: ethers.js, quest-globals.js, wallet-modal.js, nav.js
// ============================================================

// Quest-specific data from QUEST_DATA
var diceOutcomes = QUEST_DATA.diceOutcomes || {};
var doubleChoiceMap = QUEST_DATA.doubleChoiceMap || {};
var gameSectionMap = QUEST_DATA.gameSectionMap || {};
var minigameSectionMap = QUEST_DATA.minigameSectionMap || {};
var sectionXpMap = QUEST_DATA.sectionXpMap || {};
var sectionMusic = QUEST_DATA.sectionMusic || {};
var introLines = QUEST_DATA.introLines || [];
var knownItems = QUEST_DATA.knownItems || {};
var HUD_ITEM_DETAILS = QUEST_DATA.hudItemDetails || {};
var ITEM_MODIFIERS = QUEST_DATA.itemModifiers || {};
var ITEM_DESCRIPTIONS = QUEST_DATA.itemDescriptions || {};
var itemAwards = QUEST_DATA.itemAwards || {};
var QUEST_SLUG = QUEST_DATA.questSlug || '';
var WORKER_URL = QUEST_DATA.workerUrl || '';
var QUEST_ID = QUEST_DATA.questId || 0;
var questData = QUEST_DATA.questMeta || {};
var _firstSectionId = QUEST_DATA.firstSectionId || null;
var _diceInitIds = QUEST_DATA.diceInitIds || [];

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
    // Tracks which branch the player chose (0 or 1) for the first two double-choice sections,
    // in encounter order. Passed as choice1/choice2 to QuestRewards.completeQuest.
    var _choiceRecord = [];

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
      var claimSection = panel.querySelector('.claim-xp-section');
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
      if (claimSection) { claimSection.style.transition = ''; claimSection.style.opacity = '0'; claimSection.style.pointerEvents = 'none'; }
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
      // totalScore = cargoScore + per-section stat bonus, matching the worker calculation.
      if (!id) {
        var _cellTotal = _sectionCells + _questRunnerXP + Object.keys(diceOutcomes).reduce(function(sum, sid) {
          return sum + ((diceState[Number(sid)] && diceState[Number(sid)].totalScore) || 0);
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
      var firstId = _firstSectionId;

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
        if (li < introLines.length - 1) await wait(2200);
      }
      await wait(400);
      if (startBtn) {
        startBtn.style.transition = 'opacity 0.8s ease';
        startBtn.style.opacity = startBtn.disabled ? '0.4' : '1';
        startBtn.style.pointerEvents = startBtn.disabled ? 'none' : 'auto';
      }
    }





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
      var claimSection = panel.querySelector('.claim-xp-section');

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
      // Reveal claim section after narrative finishes typing
      if (claimSection) {
        await wait(400);
        if (!alive()) return;
        claimSection.style.transition = 'opacity 1.2s ease';
        claimSection.style.opacity = '1';
        claimSection.style.pointerEvents = 'auto';
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
    _diceInitIds.forEach(function(sid) { getDiceState(sid); });
    // Quest starts when the player clicks START on the intro overlay

    // ===== WALLET + ON-CHAIN INTEGRATION =====
    // CONTRACT_ADDRESS, QUEST_REWARDS_ADDRESS, ABIs, READ_RPC, etc. are loaded
    // from ../../js/quest-globals.js — update that file when contracts are redeployed.
    var _cachedReadProvider = null;
    function _getReadProvider() {
      if (_cachedReadProvider) return _cachedReadProvider;
      var _chainConfig = { chainId: parseInt(AVAX_CHAIN_ID, 16), name: 'avalanche' };
      _cachedReadProvider = new ethers.providers.FallbackProvider([
        { provider: new ethers.providers.StaticJsonRpcProvider(READ_RPC, _chainConfig), priority: 1, stallTimeout: 3000 },
        { provider: new ethers.providers.StaticJsonRpcProvider(READ_RPC_FALLBACK, _chainConfig), priority: 2, stallTimeout: 3000 },
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
        var chainId = await raw.request({ method: 'eth_chainId' });
        if (chainId === AVAX_CHAIN_ID) return;
      } catch(_) {}
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

    // WalletConnect session persistence
    var _wcProvider = null;
    var WC_KEY = 'lc_wallet_type';
    function _saveWallet(t) { try { localStorage.setItem(WC_KEY, t); } catch(_) {} }
    function _clearWallet() { try { localStorage.removeItem(WC_KEY); } catch(_) {} }
    function _getSavedWallet() { try { return localStorage.getItem(WC_KEY); } catch(_) { return null; } }

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
        var accounts;
        try { accounts = await raw.request({ method: 'eth_accounts' }); } catch(_) { accounts = []; }
        if (!accounts || accounts.length === 0) {
          accounts = await Promise.race([
            raw.request({ method: 'eth_requestAccounts' }),
            new Promise(function(_, rej) { setTimeout(function() { rej(new Error('Connection timed out.')); }, 10000); })
          ]);
        }
        if (!accounts || accounts.length === 0) throw new Error('No accounts');
        try { await switchToAvalanche(raw); } catch(_) {}
        walletProvider = new ethers.providers.Web3Provider(raw);
        walletSigner = walletProvider.getSigner();
        _saveWallet(name || 'injected');
        onConnected(accounts[0]);
        try {
          raw.on('accountsChanged', function(accs) { if (accs.length === 0) onDisconnected(); else onConnected(accs[0]); });
          raw.on('chainChanged', function() { window.location.reload(); });
        } catch(_) {}
      } catch (err) { if (err.code !== 4001) alert('Connection failed: ' + (err.message || err)); }
    }

    function loadWcScript() {
      if (window.WalletConnectEthereumProvider) return Promise.resolve();
      return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = '/assets/walletconnect-provider.js';
        s.onload = resolve; s.onerror = function() { reject(new Error('Failed to load WalletConnect')); };
        document.head.appendChild(s);
      });
    }

    async function _initWc() {
      await loadWcScript();
      var _cid = parseInt(AVAX_CHAIN_ID, 16);
      return window.WalletConnectEthereumProvider.EthereumProvider.init({ projectId: WALLETCONNECT_PROJECT_ID, chains: [_cid], showQrModal: true, rpcMap: { [_cid]: READ_RPC } });
    }

    function _setupWcListeners(wc) {
      wc.on('accountsChanged', function(accs) { if (accs.length === 0) { _clearWallet(); onDisconnected(); } else onConnected(accs[0]); });
      wc.on('disconnect', function() { _wcProvider = null; _clearWallet(); onDisconnected(); });
    }

    async function connectWalletConnect() {
      try {
        var wc = await _initWc();
        await wc.connect();
        _wcProvider = wc;
        walletProvider = new ethers.providers.Web3Provider(wc);
        walletSigner = walletProvider.getSigner();
        _saveWallet('walletconnect');
        onConnected(await walletSigner.getAddress());
        _setupWcListeners(wc);
      } catch (err) { alert('WalletConnect failed. Please try again.'); }
    }

    async function connectWallet(name) {
      // Core mobile has no injected provider — must use WalletConnect
      if (name === 'walletconnect') { await connectWalletConnect(); return; }
      if (name === 'core' && isMobile()) {
        var coreInjected = window.avalanche || (window.core && window.core.ethereum) || (window.ethereum && (window.ethereum.isAvalanche || window.ethereum.isCoreWallet));
        if (!coreInjected) { await connectWalletConnect(); return; }
      }
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
          if (currentSectionId != null) {
            _runnerScores[currentSectionId] = _rXP;
            // Send runner XP to worker immediately (like dice scores) so it's counted in /session/win
            if (WORKER_URL && chadId) {
              fetch(WORKER_URL + '/session/visit-section', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'runner_' + currentSectionId, sectionXp: _rXP }),
              }).catch(function() {});
            }
          }
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

    // Auto-reconnect wallet on page load (supports WalletConnect session restore)
    (async function() {
      var saved = _getSavedWallet();
      if (saved === 'walletconnect') {
        try {
          var wc = await _initWc();
          if (wc.session) {
            _wcProvider = wc;
            walletProvider = new ethers.providers.Web3Provider(wc);
            walletSigner = walletProvider.getSigner();
            onConnected(await walletSigner.getAddress());
            _setupWcListeners(wc);
            return;
          }
        } catch(e) { _clearWallet(); }
      }
      var raw = window.ethereum || window.avalanche;
      if (raw) {
        try {
          var accounts = await raw.request({ method: 'eth_accounts' });
          if (accounts && accounts.length > 0) {
            try { await switchToAvalanche(raw); } catch(_) {}
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
        _setText(statusEl, 'SYNCING CELLS...');
        try {
          // Final reconciliation: replay ALL tracked XP sources to the worker before /session/win.
          // The worker deduplicates by sectionId, so replaying is always safe and ensures
          // nothing was lost from earlier fire-and-forget calls.
          var _replayPromises = [];
          Object.keys(_visitedSections).forEach(function(sid) {
            if (sectionXpMap[sid] !== undefined) {
              _replayPromises.push(
                fetch(WORKER_URL + '/session/visit-section', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: sid, sectionXp: sectionXpMap[sid] }),
                }).catch(function() {})
              );
            }
          });
          Object.keys(_runnerScores).forEach(function(sid) {
            _replayPromises.push(
              fetch(WORKER_URL + '/session/visit-section', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'runner_' + sid, sectionXp: _runnerScores[sid] }),
              }).catch(function() {})
            );
          });
          Object.keys(_scoredDiceSections).forEach(function(sid) {
            _replayPromises.push(
              fetch(WORKER_URL + '/session/visit-section', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID, sectionId: 'dice_' + sid, sectionXp: _scoredDiceSections[sid] }),
              }).catch(function() {})
            );
          });
          await Promise.all(_replayPromises);
        } catch(e) { /* reconciliation failed — proceed with whatever worker has */ }

        _setText(statusEl, 'CALCULATING CELLS...');
        try {
          var winResp = await fetch(WORKER_URL + '/session/win', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenId: chadId, questId: QUEST_ID }),
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