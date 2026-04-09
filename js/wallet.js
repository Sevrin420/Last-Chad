/**
 * wallet.js — Last Chad wallet connection via AppKit (Reown)
 *
 * AppKit handles Core, Rabby, MetaMask, and WalletConnect automatically
 * across desktop and mobile without any wallet-specific code.
 *
 * Usage (in a <script type="module">):
 *   import { connectWallet, autoReconnect, disconnect,
 *            getSigner, getUserAddress, truncateAddress } from './js/wallet.js';
 */

import { AVAX_CHAIN_ID, AVAX_CHAIN, WALLETCONNECT_PROJECT_ID } from './config.js';

// Re-export so existing consumers that import from wallet.js still work
export { AVAX_CHAIN_ID, AVAX_CHAIN, WALLETCONNECT_PROJECT_ID };

// ========== MODULE STATE ==========
let _provider    = null;
let _signer      = null;
let _userAddress = null;
let _modal       = null;
let _onConnected    = null;
let _onDisconnected = null;

export function getProvider()    { return _provider; }
export function getSigner()      { return _signer; }
export function getUserAddress() { return _userAddress; }

// ========== HELPERS ==========
export function isMobile() {
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}

export function truncateAddress(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ========== APPKIT BUNDLE LOADER ==========
function _loadAppKit() {
  if (window.AppKitLib) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/assets/appkit.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load AppKit SDK'));
    document.head.appendChild(s);
  });
}

// ========== APPKIT INIT (idempotent) ==========
async function _initAppKit() {
  if (_modal) return _modal;

  await _loadAppKit();

  const { createAppKit, EthersAdapter, avalanche } = window.AppKitLib;
  const ethersAdapter = new EthersAdapter();

  _modal = createAppKit({
    adapters: [ethersAdapter],
    networks: [avalanche],
    defaultNetwork: avalanche,
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: 'Last Chad',
      description: 'NFT Adventure RPG on Avalanche',
      url: window.location.origin,
      icons: [window.location.origin + '/assets/mainbg.png']
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false
    }
  });

  // Fires on connect / disconnect / account change
  _modal.subscribeAccount(async (account) => {
    if (account.isConnected && account.address) {
      try {
        const rawProvider = _modal.getWalletProvider();
        if (rawProvider) {
          _provider    = new ethers.providers.Web3Provider(rawProvider);
          _signer      = _provider.getSigner();
          _userAddress = account.address;
          if (_onConnected) _onConnected(account.address);
        }
      } catch (e) {
        console.error('AppKit provider setup error:', e);
      }
    } else if (!account.isConnected && _userAddress !== null) {
      _provider    = null;
      _signer      = null;
      _userAddress = null;
      if (_onDisconnected) _onDisconnected();
    }
  });

  // Expose globals for pages that call openWalletModal() directly
  window.openWalletModal  = () => _modal.open();
  window.closeWalletModal = () => _modal.close();

  return _modal;
}

// ========== CONNECT ==========
export async function connectWallet(walletName, callbacks) {
  if (callbacks) {
    _onConnected    = callbacks.onConnected;
    _onDisconnected = callbacks.onDisconnected;
  }
  const modal = await _initAppKit();
  modal.open();
}

// ========== DISCONNECT ==========
export async function disconnect(onDisconnectedCb) {
  if (onDisconnectedCb) _onDisconnected = onDisconnectedCb;
  try {
    const modal = await _initAppKit();
    await modal.disconnect();
  } catch (e) {
    // If disconnect fails, clear state anyway
    _provider    = null;
    _signer      = null;
    _userAddress = null;
    if (onDisconnectedCb) onDisconnectedCb();
  }
}

// ========== AUTO-RECONNECT ==========
export async function autoReconnect(callbacks) {
  _onConnected    = callbacks.onConnected;
  _onDisconnected = callbacks.onDisconnected;

  try {
    const modal = await _initAppKit();

    // AppKit restores existing sessions on init — check immediately
    const rawProvider = modal.getWalletProvider();
    if (rawProvider) {
      const ethProvider = new ethers.providers.Web3Provider(rawProvider);
      const signer = ethProvider.getSigner();
      const addr = await signer.getAddress();
      if (addr) {
        _provider    = ethProvider;
        _signer      = signer;
        _userAddress = addr;
        callbacks.onConnected(addr);
      }
    }
  } catch (e) {
    // Silently ignore — user may not have a prior session
  }
}

// ========== ENSURE SIGNER ==========
export async function ensureSigner() {
  if (_signer) return _signer;
  // Try to restore via AppKit if already initialised
  if (_modal) {
    try {
      const rawProvider = _modal.getWalletProvider();
      if (rawProvider) {
        _provider    = new ethers.providers.Web3Provider(rawProvider);
        _signer      = _provider.getSigner();
        _userAddress = await _signer.getAddress();
        return _signer;
      }
    } catch (_) {}
  }
  return null;
}
