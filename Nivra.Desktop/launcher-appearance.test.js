'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { isTrustedIpc } = require('./renderer-security');
const { ICON_IDS, createLauncherAppearanceManager, installLauncherAppearanceHandlers } = require('./launcher-appearance');

function iconBytes(marker = 1) {
  const bytes = Buffer.alloc(32, marker);
  bytes.writeUInt16LE(0, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(1, 4);
  return bytes;
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nivra-launcher-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^nivra-launcher-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const userDataDirectory = path.join(root, 'profile');
  const bundleDirectory = path.join(root, 'bundle');
  const desktopDirectory = path.join(root, 'Desktop');
  const startMenuDirectory = path.join(root, 'Programs');
  const executablePath = path.join(root, 'installed', 'Nivra.exe');
  for (const directory of [bundleDirectory, desktopDirectory, path.join(startMenuDirectory, 'Nivra')]) fs.mkdirSync(directory, { recursive: true });
  ICON_IDS.forEach((id, index) => fs.writeFileSync(path.join(bundleDirectory, `launcher-${id}.ico`), iconBytes(index + 1)));
  const links = new Map();
  const writes = [], windows = [];
  const shell = {
    readShortcutLink: file => { if (!links.has(file)) throw new Error('Missing'); return links.get(file); },
    writeShortcutLink: (...args) => { writes.push(args); return true; },
  };
  const options = { platform: 'win32', isPackaged: true, userDataDirectory, bundleDirectory,
    desktopDirectory, startMenuDirectory, executablePath, shell,
    setWindowIcon: file => windows.push(file), ...overrides };
  const shortcutPaths = [path.join(desktopDirectory, 'Nivra.lnk'), path.join(startMenuDirectory, 'Nivra', 'Nivra.lnk')];
  const addShortcut = (index, details = {}) => {
    const file = shortcutPaths[index]; fs.writeFileSync(file, 'test shortcut');
    links.set(file, { target: executablePath, args: '', description: 'Nivra', ...details });
    return file;
  };
  return { root, options, manager: createLauncherAppearanceManager(options), writes, windows, addShortcut,
    userDataDirectory, bundleDirectory, shortcutPaths, executablePath };
}

test('selection exposes only an allowlisted ID and persists atomically in the OS-user profile', t => {
  const f = fixture(t); f.addShortcut(0); f.addShortcut(1);
  f.manager.restore();
  assert.deepEqual(f.manager.getState(), { supported: true, icon: 'original', scope: 'os-user' });
  const state = f.manager.setIcon('emerald');
  assert.deepEqual(state, { supported: true, icon: 'emerald', scope: 'os-user' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userDataDirectory, 'launcher-appearance.json'))), { schema: 1, icon: 'emerald' });
  assert.ok(f.manager.getIconPath().startsWith(path.join(f.userDataDirectory, 'launcher-icons') + path.sep));
  assert.equal(path.extname(f.manager.getIconPath()), '.ico');
  assert.equal(fs.readdirSync(f.userDataDirectory).some(name => name.endsWith('.tmp')), false);
  assert.equal(JSON.stringify(state).includes(f.root), false);
  assert.equal(f.windows.at(-1), f.manager.getIconPath());
});

test('startup preserves the user choice and reapplies it after an installer resets existing links', t => {
  const f = fixture(t); f.addShortcut(0); f.addShortcut(1);
  f.manager.restore(); f.manager.setIcon('ivory'); f.writes.length = 0;
  const upgraded = createLauncherAppearanceManager(f.options);
  assert.equal(upgraded.restore().icon, 'ivory');
  assert.equal(f.writes.length, 2);
  for (const [file, operation, details] of f.writes) {
    assert.ok(f.shortcutPaths.includes(file)); assert.equal(operation, 'update');
    assert.deepEqual(Object.keys(details).sort(), ['icon', 'iconIndex']);
    assert.equal(details.icon, upgraded.getIconPath()); assert.equal(details.iconIndex, 0);
  }
});

test('unknown IDs, paths, URLs, objects and traversal never become native paths or preferences', t => {
  const f = fixture(t); f.manager.restore();
  for (const value of ['', '../ivory', '..\\ivory', 'C:\\bad.ico', 'https://bad.test/a.ico', '__proto__', null, {}, { icon: 'ivory' }]) {
    assert.throws(() => f.manager.setIcon(value), /LAUNCHER_INVALID_ICON/);
  }
  assert.equal(f.manager.getState().icon, 'original');
  assert.equal(fs.existsSync(path.join(f.userDataDirectory, 'launcher-appearance.json')), false);
  assert.equal(f.writes.length, 0);
});

test('only updates existing fixed Nivra links targeting this executable with no arguments', t => {
  const f = fixture(t);
  f.addShortcut(0, { target: path.join(f.root, 'other', 'Nivra.exe') });
  f.addShortcut(1, { args: '--custom-flow' });
  fs.writeFileSync(path.join(f.options.desktopDirectory, 'Other app.lnk'), 'other');
  f.manager.restore(); f.manager.setIcon('emerald');
  assert.equal(f.writes.length, 0);
  fs.unlinkSync(f.shortcutPaths[0]); fs.unlinkSync(f.shortcutPaths[1]);
  f.manager.setIcon('ivory');
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(f.shortcutPaths[0]), false);
  assert.equal(fs.existsSync(f.shortcutPaths[1]), false);
});

test('malformed or oversized preferences fall back without following an icon path from JSON', t => {
  const f = fixture(t); fs.mkdirSync(f.userDataDirectory);
  const file = path.join(f.userDataDirectory, 'launcher-appearance.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, icon: '../../outside', path: 'C:\\private.ico' }));
  assert.equal(f.manager.restore().icon, 'original');
  fs.writeFileSync(file, 'x'.repeat(1500));
  assert.equal(createLauncherAppearanceManager(f.options).restore().icon, 'original');
  assert.equal(f.writes.length, 0);
});

test('a failed atomic preference commit retains the prior selection and removes its private temporary file', t => {
  const f = fixture(t); f.manager.restore(); f.manager.setIcon('emerald');
  const file = path.join(f.userDataDirectory, 'launcher-appearance.json');
  const old = fs.readFileSync(file, 'utf8');
  const io = Object.create(fs);
  io.renameSync = (source, destination) => {
    if (destination === file) throw Object.assign(new Error('Simulated disk failure'), { code: 'EACCES' });
    fs.renameSync(source, destination);
  };
  const manager = createLauncherAppearanceManager({ ...f.options, fs: io }); manager.restore();
  assert.throws(() => manager.setIcon('ivory'), /Simulated disk failure/);
  assert.equal(manager.getState().icon, 'emerald');
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  assert.equal(fs.readdirSync(f.userDataDirectory).some(name => name.endsWith('.tmp')), false);
});

test('refuses symlink destinations and shortcut links without modifying their targets', t => {
  const f = fixture(t); f.addShortcut(0);
  const io = Object.create(fs);
  io.lstatSync = file => {
    const stat = fs.lstatSync(file);
    if (file === f.shortcutPaths[0] || file.endsWith('launcher-ivory.ico') && file.includes('launcher-icons')) {
      return { ...stat, isFile: () => true, isSymbolicLink: () => true };
    }
    return stat;
  };
  const manager = createLauncherAppearanceManager({ ...f.options, fs: io }); manager.restore();
  assert.equal(f.writes.length, 0);
  fs.writeFileSync(path.join(f.userDataDirectory, 'launcher-icons', 'launcher-ivory.ico'), iconBytes(3));
  assert.throws(() => manager.setIcon('ivory'), /LAUNCHER_STORAGE/);
  assert.equal(manager.getState().icon, 'original');
});

test('unavailable platforms and development shells never mutate the filesystem', t => {
  for (const overrides of [{ platform: 'linux' }, { isPackaged: false }, { shell: {} }]) {
    const f = fixture(t, overrides);
    assert.equal(f.manager.restore().supported, false);
    assert.throws(() => f.manager.setIcon('emerald'), /LAUNCHER_UNAVAILABLE/);
    assert.equal(fs.existsSync(f.userDataDirectory), false);
  }
});

test('IPC validates the exact trusted main frame and rejects extra parameters before any action', () => {
  const handlers = new Map(), calls = [];
  const entry = pathToFileURL(path.join(os.tmpdir(), 'Nivra-entry', 'index.html')).href;
  const window = { isDestroyed: () => false, webContents: { mainFrame: { url: entry } } };
  const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  installLauncherAppearanceHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedRenderer: event => { if (!isTrustedIpc(event, window, entry)) throw new Error('Untrusted IPC sender.'); },
    manager: { getState: () => { calls.push('get'); return { icon: 'original' }; }, setIcon: id => { calls.push(id); return { icon: id }; } },
  });
  const get = handlers.get('nivra-launcher:get-state'), set = handlers.get('nivra-launcher:set-icon');
  for (const event of [{ sender: {}, senderFrame: valid.senderFrame }, { sender: valid.sender, senderFrame: { url: entry } }]) {
    assert.throws(() => get(event), /Untrusted IPC sender/);
    assert.throws(() => set(event, 'emerald'), /Untrusted IPC sender/);
  }
  assert.throws(() => get(valid, 'path'), /LAUNCHER_INVALID_ICON/);
  assert.throws(() => set(valid, { icon: 'ivory', path: '../bad.ico' }), /LAUNCHER_INVALID_ICON/);
  assert.throws(() => set(valid, 'emerald', 'extra'), /LAUNCHER_INVALID_ICON/);
  assert.equal(calls.length, 0);
  assert.deepEqual(get(valid), { icon: 'original' });
  assert.deepEqual(set(valid, 'emerald'), { icon: 'emerald' });
  window.webContents.mainFrame.url = 'https://foreign.test';
  assert.throws(() => set(valid, 'ivory'), /Untrusted IPC sender/);
  assert.deepEqual(calls, ['get', 'emerald']);
});

test('IPC errors never expose private filesystem diagnostics', () => {
  const handlers = new Map();
  installLauncherAppearanceHandlers({ ipcMain: { handle: (key, value) => handlers.set(key, value) },
    assertTrustedRenderer: () => {}, manager: { setIcon: () => { throw new Error('C:\\private\\profile\\disk error'); } } });
  assert.throws(() => handlers.get('nivra-launcher:set-icon')({}, 'ivory'), error => error.message === 'LAUNCHER_FAILED');
});

test('preload exposes only enum actions, never an icon URL or filesystem path', async () => {
  const bridges = {}, invokes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { bridges[name] = value; } },
    ipcRenderer: { invoke: async (...args) => { invokes.push(args); return {}; } },
  }) });
  const bridge = bridges.nivraLauncherAppearance;
  await bridge.getState({ path: 'C:\\bad' });
  await bridge.setIcon('emerald', { path: 'C:\\bad' });
  for (const bad of ['../bad', 'https://bad.test/a.ico', { icon: 'ivory' }]) assert.throws(() => bridge.setIcon(bad), /LAUNCHER_INVALID_ICON/);
  assert.deepEqual(invokes, [['nivra-launcher:get-state'], ['nivra-launcher:set-icon', 'emerald']]);
});
