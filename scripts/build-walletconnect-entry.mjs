// Entry point for WalletConnect EthereumProvider browser bundle.
// Exposes window.WalletConnectEthereumProvider.EthereumProvider
// to match the existing usage in wallet.js (loadWcScript).
import { EthereumProvider } from '@walletconnect/ethereum-provider';
window.WalletConnectEthereumProvider = { EthereumProvider };
