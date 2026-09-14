import { Story } from '../../core/models/nivra.models';

export interface ChatStoryHighlight {
  id: string;
  targetId: string;
  isGroup: boolean;
  isOwn: boolean;
  unviewed: boolean;
  latestAt: number;
  stories: Story[];
}

export function withOwnChatStoryHighlight(highlights: ChatStoryHighlight[], userId: string): ChatStoryHighlight[] {
  const targetId = userId.toLowerCase();
  const own = highlights.find((highlight) => highlight.isOwn) ?? {
    id: `owner:${targetId}`, targetId, isGroup: false, isOwn: true, unviewed: false, latestAt: 0, stories: [],
  };
  return [own, ...highlights.filter((highlight) => !highlight.isOwn)];
}

export function chatStoryRingColor(highlight: ChatStoryHighlight): string {
  if (!highlight.stories.length) { return 'transparent'; }
  if (!highlight.unviewed) { return '#D3D3D3'; }
  return highlight.isGroup ? '#8A2BE2' : '#25D366';
}

/** Organize only the feed already authorized by SocialService; never fetch a new audience here. */
export function groupChatStoryHighlights(stories: Story[], userId: string, now: number): ChatStoryHighlight[] {
  const highlights = new Map<string, ChatStoryHighlight>();
  const seen = new Set<string>();
  for (const story of stories) {
    if (seen.has(story.id) || (story.expiresAt && !(Date.parse(story.expiresAt) > now))) {
      continue;
    }
    seen.add(story.id);
    const isGroup = String(story.targetType || '').toLowerCase() === 'group' || Boolean(story.targetId);
    const targetId = (isGroup ? story.targetId : story.owner.id)?.toLowerCase();
    if (!targetId) {
      continue;
    }
    const isMine = story.owner.id.toLowerCase() === userId.toLowerCase();
    const id = `${isGroup ? 'group' : 'owner'}:${targetId}`;
    const highlight = highlights.get(id) ?? {
      id, targetId, isGroup, isOwn: !isGroup && isMine, unviewed: false, latestAt: 0, stories: [],
    };
    highlight.unviewed ||= !story.viewedByMe && !isMine;
    highlight.latestAt = Math.max(highlight.latestAt, Date.parse(story.createdAt) || 0);
    highlight.stories.push(story);
    highlights.set(id, highlight);
  }
  for (const highlight of highlights.values()) {
    highlight.stories.sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
  }
  return [...highlights.values()].sort((left, right) =>
    Number(right.isOwn) - Number(left.isOwn) ||
    Number(right.unviewed) - Number(left.unviewed) ||
    right.latestAt - left.latestAt || left.id.localeCompare(right.id));
}
