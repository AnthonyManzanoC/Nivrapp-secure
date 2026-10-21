'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ICON_IDS = Object.freeze(['original', 'emerald', 'ivory']);
const ICON_FILES = Object.freeze(Object.fromEntries(ICON_IDS.map(id => [id, `launcher-${id}.ico`])));

function isLauncherIcon(value) {
  return typeof value === 'string' && ICON_IDS.includes(value);
}

function createLauncherAppearanceManager(options) {
  const io = options.fs || fs;
  const supported = options.platform === 'win32' && options.isPackaged
    && typeof options.shell?.readShortcutLink === 'function'
    && typeof options.shell?.writeShortcutLink === 'function';
  const userDirectory = path.resolve(options.userDataDirectory);
  const iconsDirectory = path.join(userDirectory, 'launcher-icons');
  const preferencePath = path.join(userDirectory, 'launcher-appearance.json');
  const executablePath = path.resolve(options.executablePath);
  const shortcuts = [
    path.join(path.resolve(options.desktopDirectory), 'Nivra.lnk'),
    path.join(path.resolve(options.startMenuDirectory), 'Nivra', 'Nivra.lnk'),
  ];
  let current = 'original';
  let iconPath = null;

  function regularFile(file, limit) {
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('LAUNCHER_STORAGE');
    return stat;
  }

  function ensureDirectory(directory) {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('LAUNCHER_STORAGE');
  }

  function writeAtomic(file, contents) {
    try { regularFile(file, 4 * 1024 * 1024); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    let descriptor;
    try {
      descriptor = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(descriptor, contents);
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = undefined;
      io.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) io.closeSync(descriptor);
      try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function prepareIcon(id) {
    // Both source and destination filenames come exclusively from this main-process allowlist.
    const source = path.join(options.bundleDirectory, ICON_FILES[id]);
    regularFile(source, 4 * 1024 * 1024);
    const bytes = io.readFileSync(source);
    if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1
      || bytes.readUInt16LE(4) < 1 || bytes.readUInt16LE(4) > 64) throw new Error('LAUNCHER_RESOURCE');
    ensureDirectory(userDirectory);
    ensureDirectory(iconsDirectory);
    // Shell shortcuts cannot resolve an icon inside app.asar. Copy this bundled resource
    // to a stable profile path, which survives replacement of the installed application.
    const destination = path.join(iconsDirectory, ICON_FILES[id]);
    let equal = false;
    try { regularFile(destination, 4 * 1024 * 1024); equal = io.readFileSync(destination).equals(bytes); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!equal) writeAtomic(destination, bytes);
    return destination;
  }

  function updateOwnedShortcuts(selectedPath) {
    for (const shortcut of shortcuts) {
      try {
        regularFile(shortcut, 1024 * 1024);
        const details = options.shell.readShortcutLink(shortcut);
        if (typeof details.target !== 'string' || details.target.includes('\0')
          || path.resolve(details.target).toLowerCase() !== executablePath.toLowerCase()
          || (details.args && details.args.trim())) continue;
        // Update only existing links that still target this executable; never create a
        // missing shortcut or change its target, arguments, working directory or identity.
        options.shell.writeShortcutLink(shortcut, 'update', { icon: selectedPath, iconIndex: 0 });
      } catch {
        // A deleted, customized, inaccessible or cached shortcut must not prevent opening Nivra.
      }
    }
  }

  function apply(selectedPath) {
    try { options.setWindowIcon?.(selectedPath); } catch { /* The next window uses getIconPath(). */ }
    updateOwnedShortcuts(selectedPath);
  }

  function getState() {
    return { supported: Boolean(supported), icon: current, scope: 'os-user' };
  }

  function restore() {
    if (!supported) return getState();
    try {
      regularFile(preferencePath, 1024);
      const saved = JSON.parse(io.readFileSync(preferencePath, 'utf8'));
      if (saved?.schema === 1 && isLauncherIcon(saved.icon)) current = saved.icon;
    } catch { /* Missing or malformed preferences use the original icon. */ }
    try {
      iconPath = prepareIcon(current);
      apply(iconPath);
    } catch { iconPath = null; /* Keep startup available if the profile cannot be written. */ }
    return getState();
  }

  function setIcon(id) {
    if (!supported) throw new Error('LAUNCHER_UNAVAILABLE');
    if (!isLauncherIcon(id)) throw new Error('LAUNCHER_INVALID_ICON');
    const selectedPath = prepareIcon(id);
    writeAtomic(preferencePath, Buffer.from(JSON.stringify({ schema: 1, icon: id }) + '\n', 'utf8'));
    current = id;
    iconPath = selectedPath;
    apply(selectedPath);
    return getState();
  }

  return { restore, getState, setIcon, getIconPath: () => iconPath };
}

function installLauncherAppearanceHandlers({ ipcMain, assertTrustedRenderer, manager }) {
  ipcMain.handle('nivra-launcher:get-state', (event, ...args) => {
    assertTrustedRenderer(event);
    if (args.length) throw new Error('LAUNCHER_INVALID_ICON');
    return manager.getState();
  });
  ipcMain.handle('nivra-launcher:set-icon', (event, ...args) => {
    assertTrustedRenderer(event);
    if (args.length !== 1 || !isLauncherIcon(args[0])) throw new Error('LAUNCHER_INVALID_ICON');
    try { return manager.setIcon(args[0]); }
    catch (error) {
      throw new Error(error?.message === 'LAUNCHER_UNAVAILABLE' ? 'LAUNCHER_UNAVAILABLE' : 'LAUNCHER_FAILED');
    }
  });
}

module.exports = { ICON_IDS, isLauncherIcon, createLauncherAppearanceManager, installLauncherAppearanceHandlers };
