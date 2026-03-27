/**
 * wallet-modal.js — Centralized wallet selection modal
 *
 * Injects the Connect Wallet modal HTML + CSS into any page that has
 * <div id="wallet-modal-placeholder"></div>.
 *
 * Exposes globals:
 *   openWalletModal()   — show the modal
 *   closeWalletModal()  — hide the modal
 *
 * Dispatches on document:
 *   CustomEvent('wallet-selected', { detail: { wallet: 'core'|'rabby'|'walletconnect' } })
 *
 * Pages listen with:
 *   document.addEventListener('wallet-selected', e =>
 *     connectWallet(e.detail.wallet, { onConnected, onDisconnected }));
 */
(function () {
  // ── CSS (scoped to #walletModal to avoid collisions) ──
  var style = document.createElement('style');
  style.textContent =
    '#walletModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;align-items:center;justify-content:center;padding:20px}' +
    '#walletModal.show{display:flex}' +
    '#walletModal .wm-box{background:linear-gradient(180deg,#1e1608 0%,#140f05 100%);border:3px solid #5c4409;border-radius:8px;padding:28px 24px;max-width:360px;width:100%;box-shadow:0 0 40px rgba(0,0,0,0.8)}' +
    '#walletModal .wm-title{font-family:"Press Start 2P",monospace;font-size:0.7rem;color:#c9a84c;text-align:center;margin:0 0 24px;letter-spacing:0.05em}' +
    '#walletModal .wm-option{display:flex;align-items:center;gap:14px;width:100%;padding:14px 16px;margin-bottom:10px;font-family:"Press Start 2P",monospace;font-size:0.5rem;color:#f5e6c8;background:rgba(61,46,10,0.3);border:2px solid #3d2e0a;border-radius:4px;cursor:pointer;transition:all 0.15s}' +
    '#walletModal .wm-option:hover{border-color:#8b6914;background:rgba(92,68,9,0.3)}' +
    '#walletModal .wm-option:active{transform:scale(0.97)}' +
    '#walletModal .wm-icon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}' +
    '#walletModal .wm-cancel{display:block;width:100%;font-family:"Press Start 2P",monospace;font-size:0.45rem;color:#5c4409;background:none;border:1px solid #3d2e0a;border-radius:4px;cursor:pointer;padding:10px;margin-top:4px;transition:all 0.15s}' +
    '#walletModal .wm-cancel:hover{color:#f5e6c8;border-color:#8b6914}' +
    /* Force WalletConnect QR modal (injected by library) above all game overlays */
    'wcm-modal,w3m-modal,w3m-core,w3m-overlay,.wcm-overlay,.w3m-overlay,[class*="walletconnect"],[id*="walletconnect"],[class*="w3m"],[class*="wcm"]{z-index:999999!important;position:fixed!important}';
  document.head.appendChild(style);

  // ── HTML ──
  var placeholder = document.getElementById('wallet-modal-placeholder');
  if (!placeholder) return;

  var modal = document.createElement('div');
  modal.id = 'walletModal';
  modal.innerHTML =
    '<div class="wm-box">' +
      '<h2 class="wm-title">Connect Wallet</h2>' +
      '<button class="wm-option" data-wallet="core">' +
        '<span class="wm-icon" style="background:#e84142;">&#9830;</span>' +
        'Core' +
      '</button>' +
      '<button class="wm-option" data-wallet="rabby">' +
        '<span class="wm-icon" style="background:#7c6be6;">&#128176;</span>' +
        'Rabby' +
      '</button>' +
      '<button class="wm-option" data-wallet="walletconnect">' +
        '<span class="wm-icon" style="background:#3b99fc;">&#128279;</span>' +
        'WalletConnect' +
      '</button>' +
      '<button class="wm-cancel" id="walletModalCancel">CANCEL</button>' +
    '</div>';

  placeholder.parentNode.replaceChild(modal, placeholder);

  // ── Close handlers ──
  document.getElementById('walletModalCancel').addEventListener('click', function () {
    modal.classList.remove('show');
  });
  modal.addEventListener('click', function (e) {
    if (e.target === modal) modal.classList.remove('show');
  });

  // ── Wallet selection → dispatch event ──
  modal.querySelectorAll('.wm-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      modal.classList.remove('show');
      document.dispatchEvent(new CustomEvent('wallet-selected', {
        detail: { wallet: btn.dataset.wallet }
      }));
    });
  });

  // ── Globals ──
  window.openWalletModal  = function () { modal.classList.add('show'); };
  window.closeWalletModal = function () { modal.classList.remove('show'); };
}());
