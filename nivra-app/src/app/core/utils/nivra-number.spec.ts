import { formatNivraNumber, isLoginIdentifier, normalizeNivraNumber } from './nivra-number';

describe('Nivra account identifiers', () => {
  it('accepts canonical and formatted IDs without treating a phone as an ID', () => {
    expect(normalizeNivraNumber('123456789')).toBe('123456789');
    expect(normalizeNivraNumber('123 456 789')).toBe('123456789');
    expect(normalizeNivraNumber('123-456-789')).toBe('123456789');
    expect(normalizeNivraNumber('+123456789')).toBeNull();
    expect(normalizeNivraNumber('000000000')).toBeNull();
    expect(normalizeNivraNumber('12345678')).toBeNull();
  });

  it('keeps explicit numeric aliases in their existing alias namespace', () => {
    expect(normalizeNivraNumber('@123456789')).toBeNull();
    expect(isLoginIdentifier('@123456789')).toBeTrue();
    expect(isLoginIdentifier('@existing.alias')).toBeTrue();
    expect(isLoginIdentifier('123 456 789')).toBeTrue();
    expect(isLoginIdentifier('not an alias')).toBeFalse();
  });

  it('formats IDs for display and handles old sessions that have not refreshed yet', () => {
    expect(formatNivraNumber('123456789')).toBe('123 456 789');
    expect(formatNivraNumber(null)).toBe('');
  });
});
