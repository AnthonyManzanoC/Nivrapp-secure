const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../nivra-app/node_modules/typescript');

const services = path.resolve(__dirname, '../nivra-app/src/app/core/services');

for (const first of ['native-device.service', 'native-secure-vault.service']) {
  test(`native device and vault share one registration when ${first} loads first`, async () => {
    const registrations = [];
    const operations = [];
    const modules = new Map();
    const AuthService = class {};
    const AppSettingsService = class {};
    const auth = { isAuthenticated: () => true };
    const plugin = {
      syncPushRegistration: async (options) => { operations.push(['push', options]); return { registered: true }; },
      getOrCreateSecureSecret: async (options) => { operations.push(['secret', options]); return { secret: 'synthetic-secure-secret', available: true }; },
      clearSecureSecret: async (options) => { operations.push(['clear', options]); },
    };
    const capacitor = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      registerPlugin: (name) => { registrations.push(name); return plugin; },
    };
    const angular = {
      Injectable: () => (target) => target,
      effect: (callback) => callback(),
      inject: (token) => token === AuthService ? auth : { settings: () => ({}) },
    };

    function load(name) {
      if (modules.has(name)) return modules.get(name).exports;
      const module = { exports: {} };
      modules.set(name, module);
      const source = fs.readFileSync(path.join(services, `${name}.ts`), 'utf8');
      const { outputText, diagnostics } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
        reportDiagnostics: true,
      });
      assert.equal(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
      const requireDependency = (dependency) => {
        if (dependency === '@angular/core') return angular;
        if (dependency === '@capacitor/core') return capacitor;
        if (dependency === './auth.service') return { AuthService };
        if (dependency === './app-settings.service') return { AppSettingsService };
        if (dependency.startsWith('./native-')) return load(dependency.slice(2));
        throw new Error(`Unexpected test dependency: ${dependency}`);
      };
      vm.runInNewContext(outputText, { exports: module.exports, module, require: requireDependency, window: {}, console }, { filename: `${name}.ts` });
      return module.exports;
    }

    load(first);
    const { NativeDeviceService } = load('native-device.service');
    const { NativeSecureVaultService } = load('native-secure-vault.service');
    const device = new NativeDeviceService();
    const vault = new NativeSecureVaultService();
    const registration = { apiBaseUrl: 'https://api.example.test', userId: 'fixture-user', deviceId: 'fixture-device', refreshToken: 'fixture-token' };
    assert.equal(await device.syncPushRegistration(registration), true);
    assert.equal(await vault.getOrCreateSecret('device-keys'), 'synthetic-secure-secret');
    assert.equal(await vault.getOrCreateSecret('device-keys', { create: false }), 'synthetic-secure-secret');
    await vault.clearSecret('device-keys');

    assert.deepEqual(registrations, ['NivraNative']);
    assert.equal(vault.requiresProtection(), true);
    assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
      ['push', registration], ['secret', { name: 'device-keys' }], ['secret', { name: 'device-keys', create: false }], ['clear', { name: 'device-keys' }],
    ]);
  });
}

function desktopVault(bridge) {
  const source = fs.readFileSync(path.join(services, 'native-secure-vault.service.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: module.exports, module, window: { nivraSecureVault: bridge },
    require: name => {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => false } };
      if (name === './native-plugin') return { NivraNative: {} };
      throw new Error(`Unexpected test dependency: ${name}`);
    },
  });
  return new module.exports.NativeSecureVaultService();
}

test('desktop vault forwards an explicit read-only request through a capable preload', async () => {
  const calls = [];
  const vault = desktopVault({ readOnlySupported: true, getOrCreateSecret: async (...args) => {
    calls.push(args); return { secret: 'retained-desktop-secret', available: true };
  } });
  assert.equal(await vault.getOrCreateSecret('device-keys', { create: false }), 'retained-desktop-secret');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['device-keys', { create: false }]]);
});

test('desktop vault never asks an older preload to read when that binary would create a replacement', async () => {
  let calls = 0;
  const vault = desktopVault({ getOrCreateSecret: async () => { calls++; return { secret: 'replacement-secret' }; } });
  assert.equal(await vault.getOrCreateSecret('device-keys', { create: false }), null);
  assert.equal(calls, 0);
});
