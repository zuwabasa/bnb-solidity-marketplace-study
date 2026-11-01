const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
let cached;
function compile() {
  if (cached) return cached;
  const root = path.join(__dirname, '..');
  const sources = Object.fromEntries(['Marketplace.sol','TestActors.sol'].map(name => [name, {
    content: fs.readFileSync(path.join(root,'contracts',name),'utf8')
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language:'Solidity', sources,
    settings:{ optimizer:{enabled:true,runs:200}, evmVersion:'shanghai',
      outputSelection:{'*':{'*':['abi','evm.bytecode.object']}} }
  })));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  return cached = {contracts:output.contracts, warnings:(output.errors || []).filter(e => e.severity !== 'error'), compiler:solc.version()};
}
if (require.main === module) {
  const result = compile();
  console.log('Compiler:',result.compiler);
  for (const [file,contracts] of Object.entries(result.contracts))
    for (const [name,artifact] of Object.entries(contracts))
      console.log(file,name,'bytecode bytes:',artifact.evm.bytecode.object.length/2);
  for (const warning of result.warnings) console.log(warning.formattedMessage);
}
module.exports = {compile};
