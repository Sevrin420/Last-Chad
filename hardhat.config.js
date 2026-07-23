require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
} = require("hardhat/builtin-tasks/task-names");

const PRIVATE_KEY        = process.env.PRIVATE_KEY || "";
const SNOWTRACE_API_KEY  = process.env.SNOWTRACE_API_KEY || "verifyContract";
const SOLC_VERSION       = "0.8.26";

// Hardhat's default compiler download (binaries.soliditylang.org) is
// unreachable from some sandboxed/offline environments. The `solc` npm
// package (a devDependency, pinned in package-lock.json) ships the same
// official solc-js WASM build, so use it directly instead of downloading —
// falls through to the normal download path for any other version.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const solcJs = require("solc");
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solcJs.version(),
    };
  }
  return runSuper(args);
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    avalanche: {
      url: "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    },
    fuji: {
      url: "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: SNOWTRACE_API_KEY,
    customChains: [
      {
        network: "avalanche",
        chainId: 43114,
        urls: {
          apiURL:     "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
          browserURL: "https://snowtrace.io",
        },
      },
      {
        network: "fuji",
        chainId: 43113,
        urls: {
          apiURL:     "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
