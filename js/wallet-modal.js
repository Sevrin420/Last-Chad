/**
 * wallet-modal.js — Legacy shim
 *
 * AppKit (Reown) now handles wallet selection and connection.
 * openWalletModal() / closeWalletModal() are set as window globals
 * by js/wallet.js after AppKit initialises.
 *
 * This file is kept for backward compatibility (pages still load it)
 * but does nothing — no HTML is injected, no modal is created.
 */
(function () {
  // Provide safe no-op stubs in case wallet.js module hasn't run yet.
  // The real implementations are set by wallet.js after AppKit loads.
  if (!window.openWalletModal)  window.openWalletModal  = function () {};
  if (!window.closeWalletModal) window.closeWalletModal = function () {};
}());
