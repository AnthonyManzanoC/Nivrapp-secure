import { Story } from '../../core/models/nivra.models';
import { chatStoryRingColor, groupChatStoryHighlights, withOwnChatStoryHighlight } from './chat-story-highlights';

describe('chat story highlights', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const story = (id: string, ownerId: string, extra: Partial<Story> = {}): Story => ({
    id,
    owner: { id: ownerId, alias: ownerId } as Story['owner'],
    expiresAt: '2026-09-14T12:00:00Z',
    createdAt: '2026-09-13T11:00:00Z',
    viewedByMe: false,
    ...extra,
  } as Story);

  it('keeps personal and group stories separate and combines different group authors', () => {
    const highlights = groupChatStoryHighlights([
      story('personal', 'friend'),
      story('group-1', 'friend', { targetType: 'group', targetId: 'room' }),
      story('group-2', 'other', { targetType: 'Group', targetId: 'ROOM' }),
    ], 'me', now);
    expect(highlights.length).toBe(2);
    expect(highlights.find((item) => item.isGroup)?.stories.map((item) => item.id)).toEqual(['group-1', 'group-2']);
    expect(highlights.find((item) => !item.isGroup)?.stories.map((item) => item.id)).toEqual(['personal']);
  });

  it('filters expired, malformed-expiry and duplicate feed records', () => {
    const active = story('active', 'friend');
    expect(groupChatStoryHighlights([
      story('expired', 'old', { expiresAt: new Date(now).toISOString() }),
      story('bad', 'old', { expiresAt: 'invalid' }), active, active,
    ], 'me', now).flatMap((item) => item.stories).map((item) => item.id)).toEqual(['active']);
  });

  it('prioritizes own stories, then unseen contacts, then viewed stories', () => {
    const highlights = groupChatStoryHighlights([
      story('seen', 'seen', { viewedByMe: true, createdAt: '2026-09-13T11:59:00Z' }),
      story('unseen', 'unseen'), story('own', 'ME', { createdAt: '2026-09-13T09:00:00Z' }),
    ], 'me', now);
    expect(highlights.map((item) => item.targetId)).toEqual(['me', 'unseen', 'seen']);
    expect(highlights[0].unviewed).toBeFalse();
  });

  it('plays each owner timeline in creation order and reflects newly viewed stories', () => {
    const older = story('older', 'friend', { createdAt: '2026-09-13T10:00:00Z', viewedByMe: true });
    const newer = story('newer', 'friend');
    const highlight = groupChatStoryHighlights([newer, older], 'me', now)[0];
    expect(highlight.stories.map((item) => item.id)).toEqual(['older', 'newer']);
    expect(highlight.unviewed).toBeTrue();
    expect(groupChatStoryHighlights([{ ...newer, viewedByMe: true }, older], 'me', now)[0].unviewed).toBeFalse();
    expect(groupChatStoryHighlights([newer, older], 'me', now + 86_400_000)).toEqual([]);
  });

  it('always includes the current user first, with no ring when there are no own stories', () => {
    const highlights = withOwnChatStoryHighlight(groupChatStoryHighlights([story('friend-story', 'friend')], 'ME', now), 'ME');
    expect(highlights.map((item) => item.targetId)).toEqual(['me', 'friend']);
    expect(highlights[0].isOwn).toBeTrue();
    expect(highlights[0].stories).toEqual([]);
    expect(chatStoryRingColor(highlights[0])).toBe('transparent');
    expect(withOwnChatStoryHighlight([], 'me').length).toBe(1);
  });

  it('keeps existing own stories and uses direct, group and viewed ring colors', () => {
    const highlights = withOwnChatStoryHighlight(groupChatStoryHighlights([
      story('own', 'me'), story('friend-story', 'friend'),
      story('room-story', 'friend', { targetType: 'group', targetId: 'room' }),
    ], 'me', now), 'me');
    expect(highlights.filter((item) => item.isOwn).length).toBe(1);
    expect(highlights[0].stories[0].id).toBe('own');
    expect(chatStoryRingColor(highlights[0])).toBe('#D3D3D3');
    expect(chatStoryRingColor(highlights.find((item) => item.targetId === 'friend')!)).toBe('#25D366');
    expect(chatStoryRingColor(highlights.find((item) => item.isGroup)!)).toBe('#8A2BE2');
  });
});
