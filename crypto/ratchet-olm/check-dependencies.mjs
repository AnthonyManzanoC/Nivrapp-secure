import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-1-Clause', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unicode-3.0', 'Zlib', 'BSL-1.0', 'Apache-2.0 WITH LLVM-exception']);
for (const pkg of metadata.packages) {
  if (pkg.name === 'nivra-ratchet-olm') continue;
  const terms = (pkg.license ?? '').replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+|\//);
  if (!terms.length || terms.some(term => !allowed.has(term))) throw Error(`Review dependency license: ${pkg.name} ${pkg.version} ${pkg.license}`);
}
const vendor = metadata.packages.find(pkg => pkg.name === 'vodozemac');
if (vendor?.version !== '0.11.1' || !vendor.source?.includes('3e11ae87d157da6bcac3cbf7825d37c8f5ed60af')) throw Error('Unexpected vendor revision');
const resolved = metadata.resolve.nodes.find(node => node.id === vendor.id);
if (resolved.features.some(feature => !['precomputed-tables'].includes(feature))) throw Error('Unexpected cryptographic feature set');
if (/fuzzing/i.test(`${process.env.RUSTFLAGS ?? ''} ${process.env.CARGO_ENCODED_RUSTFLAGS ?? ''}`)) throw Error('Fuzzing is forbidden');
console.log(`PASS ${metadata.packages.length} dependency license declarations and pinned cryptographic features`);
