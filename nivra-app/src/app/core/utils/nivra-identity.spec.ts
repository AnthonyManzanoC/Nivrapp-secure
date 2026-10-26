import { identityDisplayName, isLegacyPrivateAlias, isNivraIdAccount, suggestNivraAlias } from './nivra-identity';

describe('Nivra ID presentation', () => {
  const oldAlias = 'n_010d9af5bd3143b6844e8d5d';
  it('keeps the numeric login ID readable without displaying a technical legacy name', () => {
    expect(identityDisplayName({ alias: oldAlias, displayName: oldAlias, nivraNumber: '619622786' })).toBe('Nivra 619 622 786');
    expect(isLegacyPrivateAlias(oldAlias)).toBeTrue();
  });
  it('honors a chosen name and identifies private accounts after an alias change', () => {
    expect(identityDisplayName({ alias: 'luna.azul42', displayName: 'Mi enigma', isPrivateAccount: true })).toBe('Mi enigma');
    expect(isNivraIdAccount({ alias: 'luna.azul42', isPrivateAccount: true })).toBeTrue();
  });
  it('does not label normal accounts or a hidden phone as private registration', () => {
    expect(isNivraIdAccount({ alias: 'maria', phone: null })).toBeFalse();
    expect(isNivraIdAccount({ alias: oldAlias, isPrivateAccount: false })).toBeFalse();
    expect(isNivraIdAccount({ alias: oldAlias, phone: '+573001234567' })).toBeFalse();
    expect(identityDisplayName({ alias: 'maria', displayName: 'María' })).toBe('María');
  });
  it('suggests a short pronounceable alias compatible with the existing server validator', () => {
    for (let index = 0; index < 30; index++) {
      const alias = suggestNivraAlias();
      expect(alias).toMatch(/^[a-z]+\.[a-z]+[0-9]{2}$/);
      expect(alias.length).toBeLessThan(25);
    }
  });
});
