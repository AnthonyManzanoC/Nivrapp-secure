using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public sealed record GroupInviteCode(string Code);
public static partial class EndpointExtensions
{
    public static void MapGroupInviteEndpoints(this WebApplication app)
    {
        app.MapPost("/conversations/{conversationId}/invite-links", async Task<IResult> (string conversationId, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            var conversation = await db.Conversations.Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == conversationId, ct);
            if (!InviteAdmin(conversation, user.UserId)) return Results.NotFound();
            var now = clock.GetUtcNow();
            if (await db.GroupInviteLinks.CountAsync(x => x.ConversationId == conversationId && x.RevokedAt == null && x.ExpiresAt > now, ct) >= 20) return Results.StatusCode(429);
            var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            var invite = new GroupInviteLink { ConversationId = conversationId, CreatorUserId = user.UserId, TokenHash = InviteHash(code), ExpiresAt = now.AddHours(24) };
            db.GroupInviteLinks.Add(invite); await db.SaveChangesAsync(ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { invite.Id, code, invite.ExpiresAt, invite.MaxUses });
        }).RequireRateLimiting("auth");
        app.MapGet("/conversations/{conversationId}/invite-links", async Task<IResult> (string conversationId, HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            var conversation = await db.Conversations.Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == conversationId, ct);
            if (!InviteAdmin(conversation, user.UserId)) return Results.NotFound();
            return Results.Ok(await db.GroupInviteLinks.Where(x => x.ConversationId == conversationId).OrderByDescending(x => x.ExpiresAt).Take(100).Select(x => new { x.Id, x.ExpiresAt, x.RevokedAt, x.Uses, x.MaxUses }).ToListAsync(ct));
        });
        app.MapDelete("/conversations/{conversationId}/invite-links/{id}", async Task<IResult> (string conversationId, string id, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            var conversation = await db.Conversations.Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == conversationId, ct);
            if (!InviteAdmin(conversation, user.UserId)) return Results.NotFound();
            await db.GroupInviteLinks.Where(x => x.Id == id && x.ConversationId == conversationId).ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, clock.GetUtcNow()), ct);
            return Results.NoContent();
        });
        app.MapPost("/group-invites/preview", async Task<IResult> (GroupInviteCode request, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            if (http.GetCurrentUser() is null) return Results.Unauthorized();
            if (!ValidInviteCode(request.Code)) return Results.NotFound();
            var hash = InviteHash(request.Code); var now = clock.GetUtcNow();
            var invite = await db.GroupInviteLinks.AsNoTracking().FirstOrDefaultAsync(x => x.TokenHash == hash && x.RevokedAt == null && x.ExpiresAt > now && x.Uses < x.MaxUses, ct);
            if (invite is null) return Results.NotFound();
            var conversation = await db.Conversations.Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == invite.ConversationId, ct);
            if (!InviteAdmin(conversation, invite.CreatorUserId)) return Results.NotFound();
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { name = conversation!.GroupName ?? "Grupo Nivra", members = conversation.Participants.Count(x => x.RemovedAt == null), invite.ExpiresAt });
        }).RequireRateLimiting("auth");
        app.MapPost("/group-invites/accept", async Task<IResult> (GroupInviteCode request, HttpContext http, NivraDbContext db, INivraStore store, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            if (!ValidInviteCode(request.Code)) return Results.NotFound();
            var hash = InviteHash(request.Code);
            string? joinedId = null;
            var result = await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear();
                await using var tx = await db.Database.BeginTransactionAsync(ct);
                var invite = await db.GroupInviteLinks.FromSqlInterpolated($"SELECT * FROM public.\"GroupInviteLinks\" WHERE \"TokenHash\" = {hash} FOR UPDATE").FirstOrDefaultAsync(ct);
                var now = clock.GetUtcNow();
                if (invite is null || invite.RevokedAt != null || invite.ExpiresAt <= now) return (IResult)Results.NotFound();
                await db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM public.conversations WHERE \"Id\" = {invite.ConversationId} FOR UPDATE", ct);
                var conversation = await db.Conversations.Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == invite.ConversationId, ct);
                if (!InviteAdmin(conversation, invite.CreatorUserId)) return Results.NotFound();
                var existing = conversation!.Participants.FirstOrDefault(x => x.UserId == user.UserId);
                if (existing?.RemovedAt != null) return Error("invite_removed_member", "Pide a un administrador que te agregue de nuevo.", 403);
                if (!GroupInvitePolicy.CanRedeem(invite, conversation, user.UserId, now)) return Results.NotFound();
                if (existing is null)
                {
                    if (invite.Uses >= invite.MaxUses) return Results.Conflict();
                    conversation.Participants.Add(new ConversationParticipant { UserId = user.UserId, Role = ParticipantRole.Member, CanInvite = NormalizeGroupSettings(conversation.Settings).AddMembers == "all", JoinedAt = now });
                    conversation.UpdatedAt = now;
                    invite.Uses++;
                    await db.SaveChangesAsync(ct);
                }
                await tx.CommitAsync(ct);
                joinedId = conversation.Id;
                return Results.Ok(new { conversationId = conversation.Id });
            });
            if (joinedId != null)
            {
                var conversation = await store.GetConversationAsync(joinedId, ct);
                if (conversation != null)
                {
                    var response = await ToConversationResponseAsync(conversation, store, ct);
                    await NotifyUsers(hub, conversation.Participants.Where(x => x.RemovedAt == null).Select(x => x.UserId), "conversation.updated", response);
                    await NotifyUsers(hub, [user.UserId], "conversation.created", response);
                }
            }
            return result;
        }).RequireRateLimiting("auth");
    }
    private static bool InviteAdmin(ConversationRecord? conversation, string userId) => GroupInvitePolicy.CanAdminister(conversation, userId);
    private static bool ValidInviteCode(string? code) => code?.Length == 43 && code.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    private static string InviteHash(string code) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code)));
}
