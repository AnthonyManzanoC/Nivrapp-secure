import { FriendRequest } from '../models/nivra.models';

export function friendRequestStatus(request: FriendRequest): string { return String(request.status || '').toLowerCase(); }
export function friendRequestTime(request: FriendRequest): number {
  return Date.parse(request.updatedAt || request.respondedAt || request.createdAt) || 0;
}

/** One current relationship per pair, retaining a genuinely newer request after removal. */
export function normalizeFriendRequests(requests: FriendRequest[], currentUserId: string): FriendRequest[] {
  const records = new Map<string, FriendRequest>();
  for (const request of requests ?? []) {
    if (!request?.id) continue;
    const previous = records.get(request.id);
    if (!previous || friendRequestTime(request) > friendRequestTime(previous)
      || (friendRequestTime(request) === friendRequestTime(previous) && friendRequestStatus(previous) === 'pending' && friendRequestStatus(request) !== 'pending')) records.set(request.id, request);
  }
  const pairs = new Map<string, FriendRequest>();
  const pendingByPair = new Map<string, FriendRequest>();
  for (const request of records.values()) {
    if (!request?.id || !request.from?.id || !request.to?.id || request.from.id === request.to.id
      || (request.from.id !== currentUserId && request.to.id !== currentUserId)) continue;
    const pair = [request.from.id, request.to.id].sort().join('\0');
    if (friendRequestStatus(request) === 'pending' && (!pendingByPair.has(pair) || friendRequestTime(request) > friendRequestTime(pendingByPair.get(pair)!))) pendingByPair.set(pair, request);
    const previous = pairs.get(pair);
    const difference = previous ? friendRequestTime(request) - friendRequestTime(previous) : 1;
    const settledTie = previous && difference === 0 && friendRequestStatus(previous) === 'pending' && friendRequestStatus(request) !== 'pending';
    if (!previous || difference > 0 || settledTie) pairs.set(pair, request);
  }
  for (const [pair, latest] of pairs) {
    const person = latest.from.id === currentUserId ? latest.to : latest.from;
    // New APIs personalize each historical DTO with the current relationship.
    // Closing a legacy duplicate must not hide a genuinely active pending row.
    if (['incoming', 'requested'].includes(person.friendshipState) && pendingByPair.has(pair)) pairs.set(pair, pendingByPair.get(pair)!);
  }
  return [...pairs.values()].filter(request => {
    const person = request.from.id === currentUserId ? request.to : request.from;
    return friendRequestStatus(request) !== 'pending' || (!person.isMutualContact && person.friendshipState !== 'friends');
  }).sort((left, right) => friendRequestTime(right) - friendRequestTime(left) || left.id.localeCompare(right.id));
}
