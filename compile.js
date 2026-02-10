const solc = require('solc');
const fs = require('fs');
const path = require('path');

function findImport(importPath) {
  const npmPath = path.resolve(__dirname, 'node_modules', importPath);
  if (fs.existsSync(npmPath)) {
    return { contents: fs.readFileSync(npmPath, 'utf8') };
  }
  return { error: 'File not found: ' + importPath };
}

const source = fs.readFileSync(path.resolve(__dirname, 'contracts/LastChad.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'LastChad.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer: { enabled: true, runs: 200 }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

if (output.errors) {
  const fatal = output.errors.filter(e => e.severity === 'error');
  if (fatal.length) {
    console.error('Compilation errors:');
    fatal.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
}

const contract = output.contracts['LastChad.sol']['LastChad'];
const abi = JSON.stringify(contract.abi);
const bytecode = '0x' + contract.evm.bytecode.object;

fs.writeFileSync(path.resolve(__dirname, 'contracts/LastChad.abi.json'), abi);
fs.writeFileSync(path.resolve(__dirname, 'contracts/LastChad.bin'), bytecode);

console.log('ABI written to contracts/LastChad.abi.json');
console.log('Bytecode written to contracts/LastChad.bin');
console.log('Bytecode length:', bytecode.length);
