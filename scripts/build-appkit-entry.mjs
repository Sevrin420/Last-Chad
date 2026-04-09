// Entry point for AppKit (Reown) browser bundle.
// Exposes window.AppKitLib = { createAppKit, EthersAdapter, avalanche }
// Used by js/wallet.js after lazy-loading /assets/appkit.js
import { createAppKit } from '@reown/appkit'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { avalanche } from '@reown/appkit/networks'
window.AppKitLib = { createAppKit, EthersAdapter, avalanche }
