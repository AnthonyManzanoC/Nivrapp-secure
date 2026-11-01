import { rankConversationTitles } from './conversation-search';

describe('local conversation search', () => {
  const items = ['Mi equipo diseño', 'Diseño', 'Diseño familia', 'Reunión diseño', 'Familia diseño'];
  const search = (query: string) => rankConversationTitles(items, query, value => value);
  it('ranks exact names, prefixes and partial matches without losing recency within a tier', () => {
    expect(search('diseño')).toEqual(['Diseño', 'Diseño familia', 'Mi equipo diseño', 'Reunión diseño', 'Familia diseño']);
  });
  it('accepts accents, mixed case and words in a different order', () => {
    expect(search('  DISENO   EQUIPO  ')).toEqual(['Mi equipo diseño']);
    expect(search('reunion')).toEqual(['Reunión diseño']);
  });
  it('handles punctuation as plain text and never modifies the source index', () => {
    expect(search('.*')).toEqual([]);
    expect(search('<script>')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(items[0]).toBe('Mi equipo diseño');
  });
});
