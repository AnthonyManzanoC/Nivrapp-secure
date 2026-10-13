using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed record StoryViewerScope(string UserId, HashSet<string> ContactOwnerIds,
    HashSet<string> MutualOwnerIds, HashSet<string> ActiveGroupIds);

public static class StoryVisibilityQuery
{
    // Two bounded relation queries replace per-story contact and membership probes.
    public static async Task<StoryViewerScope> ReadScopeAsync(NivraDbContext db, string userId, CancellationToken token)
    {
        var contacts = await db.Contacts.AsNoTracking()
            .Where(contact => contact.OwnerUserId == userId || contact.ContactUserId == userId)
            .Select(contact => new { contact.OwnerUserId, contact.ContactUserId }).ToListAsync(token);
        var incoming = contacts.Where(contact => contact.ContactUserId == userId).Select(contact => contact.OwnerUserId).ToHashSet(StringComparer.Ordinal);
        var outgoing = contacts.Where(contact => contact.OwnerUserId == userId).Select(contact => contact.ContactUserId).ToHashSet(StringComparer.Ordinal);
        var mutual = incoming.Intersect(outgoing, StringComparer.Ordinal).ToHashSet(StringComparer.Ordinal);
        var groups = (await db.Conversations.AsNoTracking()
            .Where(group => group.Type == ConversationType.Group && group.Participants.Any(member => member.UserId == userId && member.RemovedAt == null))
            .Select(group => group.Id).ToListAsync(token)).ToHashSet(StringComparer.Ordinal);
        return new(userId, incoming, mutual, groups);
    }

    public static IQueryable<StoryRecord> Visible(NivraDbContext db, StoryViewerScope scope, DateTimeOffset now)
    {
        var viewer = scope.UserId;
        var contacts = scope.ContactOwnerIds;
        var mutual = scope.MutualOwnerIds;
        var groups = scope.ActiveGroupIds;
        Expression<Func<StoryRecord, bool>> visible = story => story.OwnerUserId == viewer ||
            ((!story.ViewOnce || !story.ViewedByUserIds.Contains(viewer)) &&
             ((story.TargetType.Trim().ToLower() == "group" || (story.TargetId != null && story.TargetId.Trim() != ""))
                 ? story.TargetId != null && groups.Contains(story.TargetId) && (story.AllowedUserIds.Count == 0 || story.AllowedUserIds.Contains(viewer))
                 : story.Visibility == StoryVisibility.PublicWorld ||
                   (story.Visibility == StoryVisibility.Contacts && contacts.Contains(story.OwnerUserId) && (story.AllowedUserIds.Count == 0 || story.AllowedUserIds.Contains(viewer))) ||
                   (story.Visibility == StoryVisibility.MutualContacts && mutual.Contains(story.OwnerUserId) && (story.AllowedUserIds.Count == 0 || story.AllowedUserIds.Contains(viewer))) ||
                   ((story.Visibility == StoryVisibility.SelectedUsers || story.Visibility == StoryVisibility.CloseFriends) && story.AllowedUserIds.Contains(viewer))));
        // These JSON sets use a value converter, so ordinary HashSet.Contains is not
        // translatable by Npgsql. Emit PostgreSQL's jsonb string membership operator.
        if (db.Database.IsNpgsql()) visible = (Expression<Func<StoryRecord, bool>>)new JsonSetMembershipVisitor().Visit(visible)!;
        return db.Stories.AsNoTracking().Where(story => story.DeletedAt == null && story.ExpiresAt > now).Where(visible);
    }

    private sealed class JsonSetMembershipVisitor : ExpressionVisitor
    {
        private static bool IsStorySet(Expression? expression) => expression is MemberExpression member &&
            member.Member.DeclaringType == typeof(StoryRecord) &&
            member.Member.Name is nameof(StoryRecord.AllowedUserIds) or nameof(StoryRecord.ViewedByUserIds);

        protected override Expression VisitMethodCall(MethodCallExpression node)
        {
            if (node.Method.Name == nameof(HashSet<string>.Contains) && IsStorySet(node.Object))
                return Expression.Call(typeof(NpgsqlJsonDbFunctionsExtensions), nameof(NpgsqlJsonDbFunctionsExtensions.JsonExists), null,
                    Expression.Constant(EF.Functions), Expression.Convert(node.Object!, typeof(object)), Visit(node.Arguments[0]));
            return base.VisitMethodCall(node);
        }

        protected override Expression VisitBinary(BinaryExpression node)
        {
            if (node.NodeType == ExpressionType.Equal && node.Left is MemberExpression { Member.Name: "Count" } count &&
                IsStorySet(count.Expression) && node.Right is ConstantExpression { Value: 0 })
                return Expression.Equal(count.Expression!, Expression.Constant(new HashSet<string>(StringComparer.Ordinal)));
            return base.VisitBinary(node);
        }
    }
}
