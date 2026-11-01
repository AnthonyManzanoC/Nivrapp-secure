/** Local-only ranking. No message content or search terms leave the device. */
export function rankConversationTitles<T>(items: readonly T[], query: string, title: (item: T) => string): T[] {
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
  const term = normalize(query).slice(0, 256);
  if (!term) return [];
  const words = term.split(/\s+/);
  return items.map((item, index) => {
    const label = normalize(title(item));
    const score = label === term ? 0 : label.startsWith(term) ? 1 : label.includes(term) ? 2
      : words.every(word => label.includes(word)) ? 3 : -1;
    return { item, index, score };
  }).filter(result => result.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(result => result.item);
}
