// Build once in CI; ship the same verified WASM and license texts to every client.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, 'production');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
function sourceHash() {
  const names = ['Cargo.toml', 'Cargo.lock', 'vendor-upstream.json', 'check-dependencies.mjs', 'distribution.mjs', ...['src', 'vendor', 'licenses'].flatMap(directory => files(resolve(root, directory)).map(name => relative(root, name)))].map(name => name.replaceAll('\\', '/')).sort();
  return hash(names.map(name => name.replaceAll('\\', '/') + '\0' + readFileSync(resolve(root, name), 'utf8').replaceAll('\r\n', '\n')).join('\0'));
}
const packageNames = ['nivra_ratchet_olm.js', 'nivra_ratchet_olm_bg.wasm'];
if (process.argv[2] === 'assemble') {
  if (process.env.CI !== 'true' || !process.env.GITHUB_SHA || !process.env.GITHUB_RUN_ID) throw Error('Assemble only after the cryptographic CI tests');
  const metadata = JSON.parse(readFileSync(resolve(root, 'dependency-metadata.json'), 'utf8'));
  let notices = readFileSync(resolve(root, 'THIRD-PARTY-NOTICES.md'), 'utf8') + '\n\n';
  for (const pkg of metadata.packages.filter(pkg => pkg.name !== 'nivra-ratchet-olm').sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = dirname(pkg.manifest_path);
    const paths = readdirSync(directory, { withFileTypes: true }).filter(entry => /^(licen[cs]es?|copying|notice|copyright|authors)(?:[._-]|$)/i.test(entry.name))
      .flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
    if (pkg.license_file) paths.push(resolve(directory, pkg.license_file));
    // These two crates omit the workspace LICENSE from their crates.io archive.
    // Retain the exact upstream 0.2.3 license (commit recorded in licenses/README).
    if (!paths.length && ['matrix-pickle', 'matrix-pickle-derive'].includes(pkg.name) && pkg.version === '0.2.3' && pkg.license === 'Apache-2.0') paths.push(resolve(root, 'licenses/matrix-pickle-0.2.3-LICENSE.txt'));
    if (!paths.length) throw Error(`Missing distribution license text: ${pkg.name} ${pkg.version}`);
    notices += `\n===== ${pkg.name} ${pkg.version} (${pkg.license}) =====\n${pkg.repository ?? ''}\n${(pkg.authors ?? []).join(', ')}\nFor alternative licenses, Nivra selects the permissive MIT/Apache/BSD alternative.\n`;
    for (const path of [...new Set(paths)].sort()) notices += `\n--- ${relative(directory, path)} ---\n${readFileSync(path, 'utf8')}\n`;
  }
  mkdirSync(resolve(output, 'pkg'), { recursive: true });
  const hashes = {};
  for (const name of packageNames) { const bytes = readFileSync(resolve(root, 'pkg/web', name)); writeFileSync(resolve(output, 'pkg', name), bytes); hashes['pkg/' + name] = hash(bytes); }
  writeFileSync(resolve(output, 'THIRD-PARTY-LICENSES.txt'), notices);
  hashes['THIRD-PARTY-LICENSES.txt'] = hash(Buffer.from(notices));
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ protocol: 5, suite: 'NIVRA-PQXDH-MLKEM768-A256GCM-1', rust: '1.93.1', wasmBindgen: '0.2.130', sourceHash: sourceHash(), commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, files: hashes }, null, 2) + '\n');
} else if (process.argv[2] !== 'verify') throw Error('Use assemble or verify');
if (!existsSync(resolve(output, 'manifest.json'))) throw Error('Missing tested ratchet distribution. Run the cryptographic build workflow before packaging Nivra.');
const manifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'));
if (manifest.protocol !== 5 || manifest.sourceHash !== sourceHash() || !/^\d+$/.test(manifest.runId) || !/^[a-f0-9]{40}$/.test(manifest.commit)) throw Error('Stale cryptographic distribution: rebuild and test the current source in CI.');
for (const name of [...packageNames.map(name => 'pkg/' + name), 'THIRD-PARTY-LICENSES.txt']) if (manifest.files[name] !== hash(readFileSync(resolve(output, name)))) throw Error('Changed cryptographic distribution: ' + name);
console.log('PASS verified hybrid WASM distribution, source provenance and third-party license texts');
