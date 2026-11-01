import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const provenance = JSON.parse(readFileSync(resolve(root, 'vendor-upstream.json'), 'utf8'));
if (provenance.revision !== '3e11ae87d157da6bcac3cbf7825d37c8f5ed60af') throw Error('Unexpected vendor provenance');
for (const [name, expected] of Object.entries(provenance.files)) {
  let data = readFileSync(resolve(root, 'vendor/vodozemac', name));
  if (name === 'src/olm/session/mod.rs') {
    const text = data.toString('utf8'), marker = /    \/\/ NIVRA_HYBRID_RECEIVER_BEGIN\n[\s\S]*?    \/\/ NIVRA_HYBRID_RECEIVER_END\n/g;
    if ([...text.matchAll(marker)].length !== 1) throw Error('Invalid receiver extension');
    data = Buffer.from(text.replace(marker, ''));
  }
  if (createHash('sha256').update(data).digest('hex') !== expected) throw Error('Unexpected upstream change: ' + name);
}
const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-1-Clause', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unicode-3.0', 'Zlib', 'BSL-1.0', 'Apache-2.0 WITH LLVM-exception']);
function compatible(expression) {
  const tokens = (expression ?? '').replace(/\//g, ' OR ').match(/[()]|[^\s()]+/g) ?? []; let index = 0;
  function atom() {
    if (tokens[index] === '(') { index++; const result = either(); if (tokens[index++] !== ')') throw Error('Invalid SPDX grouping'); return result; }
    let id = tokens[index++]; if (tokens[index] === 'WITH') { index++; id += ' WITH ' + tokens[index++]; } return allowed.has(id);
  }
  function both() { let result = atom(); while (tokens[index] === 'AND') { index++; const next = atom(); result = result && next; } return result; }
  function either() { let result = both(); while (tokens[index] === 'OR') { index++; const next = both(); result = result || next; } return result; }
  const result = either(); return index === tokens.length && result;
}
for (const pkg of metadata.packages) {
  if (pkg.name === 'nivra-ratchet-olm') continue;
  if (!compatible(pkg.license)) throw Error(`Review dependency license: ${pkg.name} ${pkg.version} ${pkg.license}`);
}
const vendor = metadata.packages.find(pkg => pkg.name === 'vodozemac');
if (vendor?.version !== '0.11.1' || vendor.source) throw Error('Unexpected vendor revision');
const resolved = metadata.resolve.nodes.find(node => node.id === vendor.id);
if (resolved.features.some(feature => !['precomputed-tables', 'low-level-api'].includes(feature))) throw Error('Unexpected cryptographic feature set');
if (/fuzzing/i.test(`${process.env.RUSTFLAGS ?? ''} ${process.env.CARGO_ENCODED_RUSTFLAGS ?? ''}`)) throw Error('Fuzzing is forbidden');
console.log(`PASS ${metadata.packages.length} dependency license declarations and pinned cryptographic features`);
