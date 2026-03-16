/**
 * wallet.js — Last Chad wallet connection module
 *
 * Handles: injected wallets (Rabby, Core, MetaMask), WalletConnect,
 *          Avalanche chain switching, mobile deep links, auto-reconnect.
 *
 * Usage (in a <script type="module">):
 *   import { connectWallet, autoReconnect, disconnect,
 *            getSigner, getUserAddress, truncateAddress } from './js/wallet.js';
 */

// ========== CHAIN CONFIG ==========
export const AVAX_CHAIN_ID = '0xa869'; // 43113 Fuji testnet
export const AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche Fuji Testnet',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://testnet.snowtrace.io/']
};

export const WALLETCONNECT_PROJECT_ID = '3aa99496af6ef381ca5d78f464777c45';

// ========== MODULE STATE ==========
let _provider = null;
let _signer   = null;
let _userAddress = null;

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

function getDappUrl()  { return window.location.href; }
function getDappHost() { return window.location.host + window.location.pathname; }

export function getMobileDeepLink(walletName) {
  const url     = getDappHost();
  const fullUrl = getDappUrl();
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS     = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  switch (walletName) {
    case 'metamask':
      return 'https://metamask.app.link/dapp/' + url;
    case 'core':
      // Core Wallet: browser URL on both platforms
      if (isAndroid) return 'https://core.app/browser?url=' + encodeURIComponent(fullUrl);
      if (isIOS)     return 'https://core.app/browser?url=' + encodeURIComponent(fullUrl);
      return 'https://core.app/browser?url=' + encodeURIComponent(fullUrl);
    case 'rabby':
      // Rabby mobile app deep link (opens in-app browser)
      if (isAndroid || isIOS) return 'rabby://browser?url=' + encodeURIComponent(fullUrl);
      return 'https://rabby.io';
    case 'trust':
      // Trust Wallet deep link
      return 'https://link.trustwallet.com/open_url?coin_id=43114&url=' + encodeURIComponent(fullUrl);
    case 'coinbase':
      // Coinbase Wallet deep link
      return 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(fullUrl);
    default:
      return null;
  }
}

// ========== CHAIN SWITCHING ==========
export async function switchToAvalanche(rawProvider) {
  try {
    await rawProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AVAX_CHAIN_ID }]
    });
  } catch (err) {
    if (err.code === 4902) {
      await rawProvider.request({
        method: 'wallet_addEthereumChain',
        params: [AVAX_CHAIN]
      });
    } else {
      throw err;
    }
  }
}

// ========== WALLETCONNECT LAZY LOADER ==========
export function loadWcScript() {
  if (window.WalletConnectEthereumProvider) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'assets/walletconnect-provider.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load WalletConnect SDK'));
    document.head.appendChild(s);
  });
}

// ========== CONNECT: INJECTED WALLETS ==========
async function connectInjected(walletName, { onConnected, onDisconnected }) {
  let rawProvider = null;

  if (walletName === 'core' && (window.avalanche || (window.core && window.core.ethereum))) {
    rawProvider = window.avalanche || window.core.ethereum;
  } else if (window.ethereum) {
    if (window.ethereum.providers && window.ethereum.providers.length) {
      for (const p of window.ethereum.providers) {
        if (walletName === 'rabby'    && p.isRabby)                          { rawProvider = p; break; }
        if (walletName === 'metamask' && p.isMetaMask && !p.isRabby)        { rawProvider = p; break; }
        if (walletName === 'core'     && (p.isAvalanche || p.isCoreWallet)) { rawProvider = p; break; }
      }
    }
    if (!rawProvider) {
      if      (walletName === 'rabby'    && window.ethereum.isRabby)                              rawProvider = window.ethereum;
      else if (walletName === 'metamask' && window.ethereum.isMetaMask)                           rawProvider = window.ethereum;
      else if (walletName === 'core'     && (window.ethereum.isAvalanche || window.ethereum.isCoreWallet)) rawProvider = window.ethereum;
      else                                                                                         rawProvider = window.ethereum;
    }
  }

  if (!rawProvider) {
    if (isMobile()) {
      const deepLink = getMobileDeepLink(walletName);
      if (deepLink) { window.location.href = deepLink; return; }
    }
    const urls = { rabby: 'https://rabby.io', core: 'https://core.app', metamask: 'https://metamask.io' };
    alert(
      walletName.charAt(0).toUpperCase() + walletName.slice(1) +
      ' wallet not detected.\n\nOn mobile: install the app and open this site in its built-in browser.\n\nOn desktop: install the browser extension from ' +
      (urls[walletName] || '')
    );
    return;
  }

  try {
    const accounts = await rawProvider.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) throw new Error('No accounts returned');

    await switchToAvalanche(rawProvider);

    _provider    = new ethers.providers.Web3Provider(rawProvider);
    _signer      = _provider.getSigner();
    _userAddress = accounts[0];
    onConnected(accounts[0]);

    rawProvider.on('accountsChanged', (accs) => {
      if (accs.length === 0) {
        _provider = null; _signer = null; _userAddress = null;
        onDisconnected();
      } else {
        _userAddress = accs[0];
        onConnected(accs[0]);
      }
    });
    rawProvider.on('chainChanged', () => window.location.reload());

  } catch (err) {
    console.error('Connection failed:', err);
    if (err.code !== 4001) alert('Failed to connect: ' + (err.message || err));
  }
}

// ========== CONNECT: WALLETCONNECT ==========
async function connectWalletConnect({ onConnected, onDisconnected }) {
  if (!WALLETCONNECT_PROJECT_ID) {
    alert('WalletConnect project ID not configured.\n\nGet one free at:\nhttps://cloud.walletconnect.com\n\nThen set WALLETCONNECT_PROJECT_ID in js/wallet.js');
    return;
  }
  try {
    await loadWcScript();
    const EthereumProvider = window.WalletConnectEthereumProvider.EthereumProvider;
    const wcProvider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: [43113],
      showQrModal: true,
      rpcMap: { 43113: 'https://api.avax-test.network/ext/bc/C/rpc' }
    });
    await wcProvider.connect();

    _provider    = new ethers.providers.Web3Provider(wcProvider);
    _signer      = _provider.getSigner();
    _userAddress = await _signer.getAddress();
    onConnected(_userAddress);

    wcProvider.on('accountsChanged', (accs) => {
      if (accs.length === 0) {
        _provider = null; _signer = null; _userAddress = null;
        onDisconnected();
      } else {
        _userAddress = accs[0];
        onConnected(accs[0]);
      }
    });
    wcProvider.on('disconnect', () => {
      _provider = null; _signer = null; _userAddress = null;
      onDisconnected();
    });

  } catch (err) {
    console.error('WalletConnect failed:', err);
    alert('WalletConnect failed to connect. Please try again or use a different wallet.');
  }
}

// ========== CONNECT: MAIN ENTRY ==========
export async function connectWallet(walletName, callbacks) {
  const hasInjected = window.ethereum || window.avalanche;

  const coreInjected = window.avalanche ||
    (window.core && window.core.ethereum) ||
    (window.ethereum && (window.ethereum.isAvalanche || window.ethereum.isCoreWallet));

  if (walletName === 'walletconnect' ||
      (walletName === 'core' && isMobile() && !coreInjected)) {
    await connectWalletConnect(callbacks);
    return;
  }
  if (!hasInjected && isMobile() && walletName !== 'walletconnect') {
    const deepLink = getMobileDeepLink(walletName);
    if (deepLink) { window.location.href = deepLink; return; }
  }
  await connectInjected(walletName, callbacks);
}

// ========== DISCONNECT ==========
export function disconnect(onDisconnectedCb) {
  _provider    = null;
  _signer      = null;
  _userAddress = null;
  onDisconnectedCb();
}

// ========== AUTO-RECONNECT ==========
export async function autoReconnect(callbacks) {
  const rawProvider = window.ethereum || window.avalanche;
  if (!rawProvider) return;
  try {
    const accounts = await rawProvider.request({ method: 'eth_accounts' });
    if (accounts && accounts.length > 0) {
      await switchToAvalanche(rawProvider);
      _provider    = new ethers.providers.Web3Provider(rawProvider);
      _signer      = _provider.getSigner();
      _userAddress = accounts[0];
      callbacks.onConnected(accounts[0]);
    }
  } catch (e) { /* silently ignore — user may not be connected */ }
}
