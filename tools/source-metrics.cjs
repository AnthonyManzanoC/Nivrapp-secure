// Counts maintained text source, never dependencies, binaries or generated output.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const extensions = new Set(['.ts', '.js', '.cjs', '.mjs', '.cs', '.java', '.html', '.scss', '.css', '.xml', '.ps1', '.nsi', '.cpp', '.h', '.swift']);
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const excluded = /(?:^|\/)(?:node_modules|dist|build|bin|obj|artifacts|\.angular|\.gradle)(?:\/|$)|^Nivra\.Api\/wwwroot_legacy\//;
const isTest = file => /(?:^|\/)(?:tests?|checks|androidTest)(?:\/|$)|\.(?:spec|test)\.|(?:Test|Tests)\.(?:cs|java)$/.test(file);
const modules = {};
const result = { method: 'Physical versioned/current source lines including comments, templates and migrations; nonBlank excludes empty lines. Excludes dependencies, generated build output, legacy wwwroot, JSON, media and documentation. application includes build tools; tests includes checks.', files: 0, physical: 0, nonBlank: 0, application: 0, tests: 0, modules };
for (const file of files) {
  if (excluded.test(file) || !extensions.has(path.extname(file))) continue;
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
  const text = fs.readFileSync(fullPath, 'utf8');
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  const module = file.includes('/') ? file.split('/')[0] : 'root';
  const group = modules[module] ??= { files: 0, physical: 0, nonBlank: 0, tests: 0 };
  const tests = isTest(file) ? lines.length : 0;
  group.files++; group.physical += lines.length; group.nonBlank += lines.filter(line => line.trim()).length; group.tests += tests;
  result.files++; result.physical += lines.length; result.nonBlank += lines.filter(line => line.trim()).length;
  result.tests += tests; result.application += lines.length - tests;
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
