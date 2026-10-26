using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    // Feed responses resolve people/relationships in three batches instead of several
    // round-trips per story and per viewer. Personal statistics remain owner-only.
    private static async Task<List<StoryResponse>> ToStoryResponsesAsync(List<StoryRecord> stories,
        string viewerId, NivraDbContext db, CancellationToken token)
    {
        if (stories.Count == 0) return [];
        var ids = stories.SelectMany(story => new[] { story.OwnerUserId, story.OriginalAuthorId })
            .Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id!).ToHashSet(StringComparer.Ordinal);
        foreach (var story in stories.Where(story => story.OwnerUserId == viewerId))
            ids.UnionWith(story.ViewedByUserIds.Concat(story.ViewEvents.Select(view => view.UserId))
                .Concat(story.Reactions.Select(reaction => reaction.UserId)).Concat(story.Comments.Select(comment => comment.UserId)));
        var users = await db.Users.AsNoTracking().Where(user => ids.Contains(user.Id) && user.DisabledAt == null)
            .ToDictionaryAsync(user => user.Id, StringComparer.Ordinal, token);
        var contacts = await db.Contacts.AsNoTracking().Where(contact =>
            (contact.OwnerUserId == viewerId && ids.Contains(contact.ContactUserId)) ||
            (contact.ContactUserId == viewerId && ids.Contains(contact.OwnerUserId))).ToListAsync(token);
        var outgoing = contacts.Where(contact => contact.OwnerUserId == viewerId).GroupBy(contact => contact.ContactUserId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var incoming = contacts.Where(contact => contact.ContactUserId == viewerId).Select(contact => contact.OwnerUserId).ToHashSet(StringComparer.Ordinal);
        var pending = (await db.FriendRequests.AsNoTracking().Where(request => request.Status == FriendRequestStatus.Pending &&
            ((request.FromUserId == viewerId && ids.Contains(request.ToUserId)) ||
             (request.ToUserId == viewerId && ids.Contains(request.FromUserId))))
            .OrderByDescending(request => request.CreatedAt).ToListAsync(token))
            .GroupBy(request => request.FromUserId == viewerId ? request.ToUserId : request.FromUserId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        UserSummaryResponse Summary(UserAccount user)
        {
            outgoing.TryGetValue(user.Id, out var saved);
            var reverse = incoming.Contains(user.Id);
            pending.TryGetValue(user.Id, out var request);
            return new(user.Id, user.Alias, user.DisplayName, VisibleContactPhone(user, viewerId, saved is not null && reverse),
                user.Bio, VisibleProfilePhoto(user, viewerId, reverse), user.IsDiscoverable, user.AllowStoryReposts,
                saved is not null, saved is not null && reverse, saved?.IsFavorite ?? false,
                saved is not null && reverse ? "friends" : request is null ? "none" : request.FromUserId == viewerId ? "requested" : "incoming",
                user.NivraNumber, user.IsPrivateAccount);
        }

        var responses = new List<StoryResponse>(stories.Count);
        foreach (var story in stories)
        {
            if (!users.TryGetValue(story.OwnerUserId, out var owner)) continue;
            var owns = story.OwnerUserId == viewerId;
            var views = owns ? story.ViewEvents.GroupBy(view => view.UserId, StringComparer.Ordinal)
                .Select(group => group.OrderBy(view => view.ViewedAt).First())
                .Concat(story.ViewedByUserIds.Where(id => story.ViewEvents.All(view => view.UserId != id))
                    .Select(id => new StoryViewEvent { UserId = id, ViewedAt = story.CreatedAt }))
                .Where(view => users.ContainsKey(view.UserId)).OrderByDescending(view => view.ViewedAt)
                .Select(view => new StoryViewResponse(Summary(users[view.UserId]), view.ViewedAt)).ToList() : [];
            var reactions = owns ? story.Reactions.OrderByDescending(reaction => reaction.ReactedAt).Where(reaction => users.ContainsKey(reaction.UserId))
                .Select(reaction => new StoryReactionResponse(reaction.Id, Summary(users[reaction.UserId]), reaction.Emoji, reaction.ReactedAt)).ToList() : [];
            var comments = owns ? story.Comments.OrderByDescending(comment => comment.CommentedAt).Where(comment => users.ContainsKey(comment.UserId))
                .Select(comment => new StoryCommentResponse(comment.Id, Summary(users[comment.UserId]), comment.MessageId, comment.CommentedAt)).ToList() : [];
            var original = story.OriginalAuthorId is not null && users.TryGetValue(story.OriginalAuthorId, out var author) ? Summary(author) : null;
            responses.Add(new(story.Id, Summary(owner), story.Visibility, NormalizeStoryTargetType(story.TargetType, story.TargetId),
                story.TargetId, story.EncryptedPayload, story.Caption, story.MediaFileObjectId, story.AllowedUserIds.ToList(), story.ViewOnce,
                story.AllowReposts, story.ViewedByUserIds.Contains(viewerId),
                story.ViewedByUserIds.Concat(story.ViewEvents.Select(view => view.UserId)).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct(StringComparer.Ordinal).Count(),
                story.Reactions.OrderByDescending(reaction => reaction.ReactedAt).FirstOrDefault(reaction => reaction.UserId == viewerId)?.Emoji,
                story.OriginalStoryId, original, views, reactions, comments, story.CreatedAt, story.ExpiresAt, story.MusicFileObjectId));
        }
        return responses;
    }
}
