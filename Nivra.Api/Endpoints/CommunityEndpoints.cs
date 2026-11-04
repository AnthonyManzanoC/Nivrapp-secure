using System.Text;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public sealed record CreateCommunityRequest(string Name, string? Description, string? Photo, List<string>? GroupIds, Guid RequestId);
public sealed record LinkCommunityGroupRequest(string ConversationId);
public sealed record CreateCommunityGroupRequest(string Name, List<string>? ParticipantUserIds, Guid RequestId);
public sealed record UpdateCommunityRequest(string Name, string? Description, string? Photo);
public sealed record CommunityGroupView(string Id, string Name, string? Photo, int MemberCount, bool Joined,
    bool RequestPending, bool CanReview, bool CanRequest);
public sealed record CommunityGroupRequestView(string GroupId, string UserId, string Name, DateTimeOffset RequestedAt);
public sealed record ReviewCommunityGroupRequest(bool? Accept);
public sealed record CommunityView(string Id, string Name, string Description, string? Photo, string Role,
    int MemberCount, DateTimeOffset UpdatedAt, List<CommunityGroupView> Groups);

public static partial class EndpointExtensions
{
    public static void MapCommunityEndpoints(this WebApplication app)
    {
        var routes = app.MapGroup("/communities").RequireRateLimiting("auth");
        routes.MapGet("/", async (HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            var rows = await db.Communities.AsNoTracking().Where(row => db.Conversations.Any(c => c.Id == row.Id &&
                c.Participants.Any(p => p.UserId == user.UserId && p.RemovedAt == null)))
                .OrderByDescending(x => x.UpdatedAt).Take(100).ToListAsync(ct);
            return Results.Ok(await CommunityResponses(db, rows, user.UserId, ct));
        });
        routes.MapGet("/{id}", async (string id, HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            var row = await db.Communities.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
            var parent = await CommunityConversation(db, id, ct);
            if (row == null || !CommunityPolicy.IsMember(parent, user.UserId)) return Results.NotFound();
            return Results.Ok(await CommunityResponse(db, row, user.UserId, ct));
        });
        routes.MapPost("/", async (CreateCommunityRequest request, HttpContext http, NivraDbContext db,
            INivraStore store, TimeProvider clock, IHubContext<NivraHub> hub, PushNotificationService push, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            var name = request.Name?.Trim() ?? "";
            if (request.RequestId == Guid.Empty || name.Length is < 1 or > 160 || (request.Description?.Length ?? 0) > 1000 || (request.GroupIds?.Count ?? 0) > CommunityPolicy.MaxGroups)
                return Error("community_invalid", "Revisa el nombre, la descripción y los grupos.", 400);
            var photo = request.Photo;
            if (!CommunityPhotoValid(photo)) return Error("community_photo", "Usa una imagen PNG, JPEG o WebP de hasta 256 KB.", 400);
            var groupIds = (request.GroupIds ?? []).Distinct(StringComparer.Ordinal).ToArray();
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, "community-create:" + user.UserId, ct);
                var operationId = CommunityOperationId(user.UserId, "create", request.RequestId);
                var prior = await db.Communities.FirstOrDefaultAsync(x => x.Id == operationId, ct);
                if (prior != null) return CommunityPolicy.IsMember(await CommunityConversation(db, prior.Id, ct), user.UserId)
                    ? Results.Ok(await CommunityResponse(db, prior, user.UserId, ct)) : Results.NotFound();
                if (await db.Communities.CountAsync(row => db.Conversations.Any(c => c.Id == row.Id && c.CreatedByUserId == user.UserId), ct) >= 20)
                    return Error("community_limit", "Puedes crear hasta 20 comunidades.", 409);
                var groups = await db.Conversations.Include(c => c.Participants).Where(c => groupIds.Contains(c.Id)).ToListAsync(ct);
                if (groups.Count != groupIds.Length || groups.Any(c => !CommunityPolicy.IsAdmin(c, user.UserId)) ||
                    await db.CommunityGroups.AnyAsync(x => groupIds.Contains(x.ConversationId), ct) ||
                    await db.Communities.AnyAsync(x => groupIds.Contains(x.Id), ct))
                    return Error("community_group", "Solo puedes vincular grupos que administras y que no pertenecen a otra comunidad.", 409);
                var members = groups.SelectMany(c => c.Participants).Where(p => p.RemovedAt == null).Select(p => p.UserId).Append(user.UserId).Distinct().ToArray();
                if (members.Length > CommunityPolicy.MaxMembers) return Error("community_members", "La comunidad admite hasta 512 miembros.", 409);
                var now = clock.GetUtcNow();
                var parent = new ConversationRecord { Id = operationId, Type = ConversationType.Group,
                    GroupName = name, GroupAvatar = photo, TitleCiphertext = Convert.ToBase64String(Encoding.UTF8.GetBytes(name)),
                    CreatedByUserId = user.UserId, CreatedAt = now, UpdatedAt = now,
                    Settings = new GroupSettings { EditInfo = "admins", SendMessages = "admins", AddMembers = "admins" } };
                foreach (var id in members) parent.Participants.Add(new ConversationParticipant { UserId = id, JoinedAt = now,
                    Role = id == user.UserId ? ParticipantRole.Owner : ParticipantRole.Member, CanInvite = id == user.UserId, CanChangePrivacy = id == user.UserId });
                db.Conversations.Add(parent);
                var row = new CommunityRecord { Id = parent.Id, Description = request.Description?.Trim() ?? "", CreatedAt = now, UpdatedAt = now };
                db.Communities.Add(row);
                db.CommunityGroups.AddRange(groups.Select(c => new CommunityGroupRecord { CommunityId = row.Id, ConversationId = c.Id, LinkedAt = now }));
                try { await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); }
                catch (DbUpdateException) { return Error("community_conflict", "Uno de los grupos cambió. Actualiza y vuelve a intentarlo.", 409); }
                await CommunityNotify(parent, store, hub, ct);
                await CommunityAddedPush(push,row.Id,members.Where(id=>id!=user.UserId),ct);
                return Results.Created("/communities/" + row.Id, await CommunityResponse(db, row, user.UserId, ct));
            });
        });
        routes.MapPost("/{id}/groups", async (string id, LinkCommunityGroupRequest request, HttpContext http, NivraDbContext db,
            INivraStore store, TimeProvider clock, IHubContext<NivraHub> hub, PushNotificationService push, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, "community:" + id, ct);
                var row = await db.Communities.FirstOrDefaultAsync(x => x.Id == id, ct);
                var parent = await CommunityConversation(db, id, ct);
                var child = await CommunityConversation(db, request.ConversationId, ct);
                if (row == null || !CommunityPolicy.CanLink(parent, child, user.UserId)) return Results.NotFound();
                if (await db.CommunityGroups.AnyAsync(x => x.CommunityId == id && x.ConversationId == request.ConversationId, ct))
                    return Results.Ok(await CommunityResponse(db, row, user.UserId, ct));
                if (await db.Communities.AnyAsync(x => x.Id == child!.Id, ct) || await db.CommunityGroups.AnyAsync(x => x.ConversationId == child!.Id, ct))
                    return Error("community_linked", "Este grupo ya está vinculado o es una comunidad.", 409);
                if (await db.CommunityGroups.CountAsync(x => x.CommunityId == id, ct) >= CommunityPolicy.MaxGroups) return Results.Conflict();
                var now = clock.GetUtcNow();
                var known = parent!.Participants.Select(p => p.UserId).ToHashSet();
                foreach (var member in child!.Participants.Where(p => p.RemovedAt == null && !known.Contains(p.UserId)))
                    parent.Participants.Add(new ConversationParticipant { UserId = member.UserId, Role = ParticipantRole.Member, JoinedAt = now });
                if (parent.Participants.Count(p => p.RemovedAt == null) > CommunityPolicy.MaxMembers) return Error("community_members", "La comunidad admite hasta 512 miembros.", 409);
                db.CommunityGroups.Add(new CommunityGroupRecord { CommunityId = id, ConversationId = child.Id, LinkedAt = now });
                row.UpdatedAt = now; parent.UpdatedAt = now;
                try { await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); }
                catch (DbUpdateException) { return Error("community_conflict", "El grupo se vinculó en otro dispositivo. Actualiza la lista.", 409); }
                await CommunityNotify(parent, store, hub, ct);
                await CommunityAddedPush(push,row.Id,parent.Participants.Where(p=>p.RemovedAt==null&&!known.Contains(p.UserId)).Select(p=>p.UserId),ct);
                return Results.Ok(await CommunityResponse(db, row, user.UserId, ct));
            });
        });
        routes.MapPatch("/{id}", async (string id, UpdateCommunityRequest request, HttpContext http, NivraDbContext db,
            INivraStore store, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            var name=request.Name?.Trim() ?? "";
            if (name.Length is < 1 or > 160 || (request.Description?.Length ?? 0)>1000 || !CommunityPhotoValid(request.Photo)) return Results.BadRequest();
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                await using var tx=await CallCoordination.LockAsync(db,"community:"+id,ct);
                var row=await db.Communities.FirstOrDefaultAsync(x=>x.Id==id,ct);var parent=await CommunityConversation(db,id,ct);
                if(row==null || !CommunityPolicy.IsAdmin(parent,user.UserId))return Results.NotFound();
                parent!.GroupName=name;parent.TitleCiphertext=Convert.ToBase64String(Encoding.UTF8.GetBytes(name));parent.GroupAvatar=request.Photo;
                row.Description=request.Description?.Trim() ?? "";row.UpdatedAt=clock.GetUtcNow();parent.UpdatedAt=row.UpdatedAt;
                await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);await CommunityNotify(parent,store,hub,ct);
                return Results.Ok(await CommunityResponse(db,row,user.UserId,ct));
            });
        });
        routes.MapPost("/{id}/groups/create", async (string id, CreateCommunityGroupRequest request, HttpContext http, NivraDbContext db,
            INivraStore store, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            var name=request.Name?.Trim()??"";if(request.RequestId == Guid.Empty || name.Length is < 1 or > 160 || (request.ParticipantUserIds?.Count??0)>CommunityPolicy.MaxMembers)return Results.BadRequest();
            return await CallCoordination.RunAsync<IResult>(db,async()=>
            {
                await using var tx=await CallCoordination.LockAsync(db,"community:"+id,ct);
                var row=await db.Communities.FirstOrDefaultAsync(x=>x.Id==id,ct);var parent=await CommunityConversation(db,id,ct);
                if(row==null||!CommunityPolicy.IsAdmin(parent,user.UserId))return Results.NotFound();
                var operationId=CommunityOperationId(user.UserId,"group:"+id,request.RequestId);
                if(await db.CommunityGroups.AnyAsync(x=>x.CommunityId==id&&x.ConversationId==operationId,ct))
                    return Results.Ok(await CommunityResponse(db,row,user.UserId,ct));
                if(await db.CommunityGroups.CountAsync(x=>x.CommunityId==id,ct)>=CommunityPolicy.MaxGroups)return Results.Conflict();
                var members=(request.ParticipantUserIds??[]).Append(user.UserId).Distinct().ToArray();
                if(members.Any(member=>!CommunityPolicy.IsMember(parent,member)))return Results.NotFound();
                var now=clock.GetUtcNow();
                var child=new ConversationRecord {Id=operationId,Type=ConversationType.Group,GroupName=name,
                    TitleCiphertext=Convert.ToBase64String(Encoding.UTF8.GetBytes(name)),CreatedByUserId=user.UserId,CreatedAt=now,UpdatedAt=now};
                foreach(var member in members)child.Participants.Add(new ConversationParticipant {UserId=member,Role=member==user.UserId?ParticipantRole.Owner:ParticipantRole.Member,
                    CanInvite=member==user.UserId,CanChangePrivacy=member==user.UserId,JoinedAt=now});
                db.Conversations.Add(child);db.CommunityGroups.Add(new CommunityGroupRecord {CommunityId=id,ConversationId=child.Id,LinkedAt=now});
                row.UpdatedAt=now;await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);
                await CommunityNotify(child,store,hub,ct);await CommunityNotify(parent!,store,hub,ct);
                return Results.Ok(await CommunityResponse(db,row,user.UserId,ct));
            });
        });
        routes.MapDelete("/{id}/groups/{groupId}", async (string id, string groupId, HttpContext http, NivraDbContext db,
            INivraStore store, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            return await CallCoordination.RunAsync<IResult>(db,async()=>
            {
                await using var tx=await CallCoordination.LockAsync(db,"community:"+id,ct);
                var parent=await CommunityConversation(db,id,ct);
                if(!CommunityPolicy.IsAdmin(parent,user.UserId))return Results.NotFound();
                await db.CommunityGroups.Where(x=>x.CommunityId==id&&x.ConversationId==groupId).ExecuteDeleteAsync(ct);
                await tx.CommitAsync(ct);await CommunityNotify(parent!,store,hub,ct);return Results.NoContent();
            });
        });
        var requestGroupJoin = async Task<IResult> (string id, string groupId, HttpContext http, NivraDbContext db,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, "community:" + id, ct);
                var parent = await CommunityConversation(db, id, ct);
                if (!CommunityPolicy.IsMember(parent, user.UserId)
                    || !await db.CommunityGroups.AnyAsync(x => x.CommunityId == id && x.ConversationId == groupId, ct)) return Results.NotFound();
                // Serialize with invite redemption as well as joins from other API instances.
                await db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM public.conversations WHERE \"Id\" = {groupId} FOR UPDATE", ct);
                var child = await CommunityConversation(db, groupId, ct);
                if (!CommunityPolicy.CanJoin(parent, child, user.UserId)) return Results.NotFound();
                if (CommunityPolicy.IsMember(child, user.UserId)) return Results.Ok(new { conversationId = groupId });
                if (child!.Participants.Count(p => p.RemovedAt == null) >= CommunityPolicy.MaxMembers)
                    return Error("group_full", "Este grupo ya está completo.", 409);
                var pending = await db.CommunityGroupRequests.FindAsync([id, groupId, user.UserId], ct);
                if (pending is { DeclinedAt: null }) return Results.Accepted(value: new { pending = true });
                var now = clock.GetUtcNow();
                if (pending?.DeclinedAt > now.AddDays(-1))
                    return Error("request_declined", "El grupo rechazó tu solicitud. Puedes volver a solicitar acceso mañana.", 409);
                if (pending == null)
                    db.CommunityGroupRequests.Add(new() { CommunityId = id, ConversationId = groupId, UserId = user.UserId, RequestedAt = now });
                else
                {
                    pending.RequestedAt = now;
                    pending.DeclinedAt = null;
                }
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                var reviewers = CommunityReviewRecipients(parent!, child, user.UserId);
                await NotifyUsers(hub, reviewers, "community.changed", new { communityId = id, joinRequestsChanged = true });
                return Results.Accepted(value: new { pending = true });
            });
        };
        routes.MapPost("/{id}/groups/{groupId}/join", requestGroupJoin);
        routes.MapPost("/{id}/groups/{groupId}/request", requestGroupJoin);
        routes.MapGet("/{id}/join-requests", async (string id, HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            if (!await db.CommunityGroups.AnyAsync(group => group.CommunityId == id, ct)
                || !CommunityPolicy.IsMember(await CommunityConversation(db, id, ct), user.UserId)) return Results.NotFound();
            var requests = await (from pending in db.CommunityGroupRequests.AsNoTracking()
                join account in db.Users.AsNoTracking() on pending.UserId equals account.Id
                where pending.CommunityId == id && pending.DeclinedAt == null
                    && db.Conversations.Any(c => c.Id == id && c.Participants.Any(p => p.UserId == pending.UserId && p.RemovedAt == null))
                    && db.Conversations.Any(c => c.Id == pending.ConversationId
                        && c.Participants.Any(p => p.UserId == user.UserId && p.RemovedAt == null
                            && (p.Role == ParticipantRole.Owner || p.Role == ParticipantRole.Admin))
                        && !c.Participants.Any(p => p.UserId == pending.UserId))
                orderby pending.RequestedAt, pending.UserId, pending.ConversationId
                select new CommunityGroupRequestView(pending.ConversationId, pending.UserId,
                    account.DisplayName ?? account.Alias, pending.RequestedAt)).Take(100).ToListAsync(ct);
            return Results.Ok(requests);
        });
        routes.MapPost("/{id}/groups/{groupId}/requests/{requesterId}", async (string id, string groupId, string requesterId,
            ReviewCommunityGroupRequest review, HttpContext http, NivraDbContext db, INivraStore store,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser(); if (user == null) return Results.Unauthorized();
            if (review.Accept is not bool accept) return Results.BadRequest();
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, "community:" + id, ct);
                var parent = await CommunityConversation(db, id, ct);
                if (!CommunityPolicy.IsMember(parent, user.UserId) || !CommunityPolicy.IsMember(parent, requesterId)
                    || !await db.CommunityGroups.AnyAsync(x => x.CommunityId == id && x.ConversationId == groupId, ct)) return Results.NotFound();
                await db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM public.conversations WHERE \"Id\" = {groupId} FOR UPDATE", ct);
                var child = await CommunityConversation(db, groupId, ct);
                if (!CommunityPolicy.IsAdmin(child, user.UserId) || !CommunityPolicy.CanJoin(parent, child, requesterId)) return Results.NotFound();
                var pending = await db.CommunityGroupRequests.FindAsync([id, groupId, requesterId], ct);
                if (pending == null || pending.DeclinedAt != null)
                    return accept && CommunityPolicy.IsMember(child, requesterId) ? Results.NoContent() : Results.NotFound();
                var now = clock.GetUtcNow();
                if (accept)
                {
                    if (!CommunityPolicy.IsMember(child, requesterId))
                    {
                        if (child!.Participants.Count(p => p.RemovedAt == null) >= CommunityPolicy.MaxMembers)
                            return Error("group_full", "Este grupo ya está completo.", 409);
                        child.Participants.Add(new ConversationParticipant { UserId = requesterId, Role = ParticipantRole.Member,
                            CanInvite = child.Settings.AddMembers == "all", JoinedAt = now });
                        child.UpdatedAt = now;
                    }
                    db.CommunityGroupRequests.Remove(pending);
                }
                else pending.DeclinedAt = now;
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                if (accept) await CommunityNotify(child!, store, hub, ct);
                var reviewers = CommunityReviewRecipients(parent!, child!, requesterId);
                await NotifyUsers(hub, reviewers, "community.changed", new { communityId = id, joinRequestsChanged = true });
                return Results.NoContent();
            });
        });
        routes.MapPost("/{id}/leave", async (string id, HttpContext http, NivraDbContext db, INivraStore store,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user=http.GetCurrentUser();if(user==null)return Results.Unauthorized();
            return await LeaveCommunityAsync(id,user.UserId,db,store,clock,hub,ct);
        });
    }

    private static async Task<IResult> LeaveCommunityAsync(string id,string userId,NivraDbContext db,INivraStore store,
        TimeProvider clock,IHubContext<NivraHub> hub,CancellationToken ct)
    {
        return await CallCoordination.RunAsync<IResult>(db,async()=>
        {
            await using var tx=await CallCoordination.LockAsync(db,"community:"+id,ct);
            if(!await db.Communities.AnyAsync(x=>x.Id==id,ct))return Results.NotFound();
            var parent=await CommunityConversation(db,id,ct);
            if(!CommunityPolicy.IsMember(parent,userId))return Results.NotFound();
            var ids=await db.CommunityGroups.Where(x=>x.CommunityId==id).Select(x=>x.ConversationId).ToListAsync(ct);
            ids.Add(id);
            // A consistent row order also serializes with ordinary group invitation acceptance.
            foreach(var key in ids.Order(StringComparer.Ordinal))
                await db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM public.conversations WHERE \"Id\" = {key} FOR UPDATE",ct);
            db.ChangeTracker.Clear();
            await db.CommunityGroupRequests.Where(request => request.CommunityId == id && request.UserId == userId).ExecuteDeleteAsync(ct);
            var groups=await db.Conversations.Include(c=>c.Participants).Where(c=>ids.Contains(c.Id)).ToListAsync(ct);
            var changed=new List<ConversationRecord>();var now=clock.GetUtcNow();
            foreach(var group in groups)
            {
                var member=group.Participants.FirstOrDefault(p=>p.UserId==userId&&p.RemovedAt==null);
                if(member==null)continue;
                member.RemovedAt=now;member.Role=ParticipantRole.Member;member.CanInvite=false;member.CanChangePrivacy=false;
                var remaining=group.Participants.Where(p=>p.RemovedAt==null).OrderBy(p=>p.JoinedAt).ToList();
                if(remaining.Count>0&&!remaining.Any(p=>p.Role is ParticipantRole.Owner or ParticipantRole.Admin))
                {remaining[0].Role=ParticipantRole.Owner;remaining[0].CanInvite=true;remaining[0].CanChangePrivacy=true;}
                group.UpdatedAt=now;changed.Add(group);
            }
            await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);
            foreach(var group in changed)
            {
                await CommunityNotify(group,store,hub,ct);
                await NotifyUsers(hub,[userId],"conversation.removed",new {conversationId=group.Id});
            }
            await NotifyUsers(hub,[userId],"community.changed",new {communityId=id});
            return Results.NoContent();
        });
    }

    private static Task<ConversationRecord?> CommunityConversation(NivraDbContext db, string id, CancellationToken ct) =>
        db.Conversations.Include(c => c.Participants).FirstOrDefaultAsync(c => c.Id == id, ct);

    private static IEnumerable<string> CommunityReviewRecipients(ConversationRecord parent, ConversationRecord group, string requesterId)
    {
        var members = parent.Participants.Where(p => p.RemovedAt == null).Select(p => p.UserId).ToHashSet();
        return group.Participants.Where(p => p.RemovedAt == null
                && (p.Role is ParticipantRole.Owner or ParticipantRole.Admin) && members.Contains(p.UserId))
            .Select(p => p.UserId).Append(requesterId).Distinct(StringComparer.Ordinal);
    }

    private static async Task<CommunityView?> CommunityResponse(NivraDbContext db, CommunityRecord row, string userId, CancellationToken ct) =>
        (await CommunityResponses(db,[row],userId,ct)).SingleOrDefault();

    private static async Task<List<CommunityView>> CommunityResponses(NivraDbContext db, IReadOnlyList<CommunityRecord> rows, string userId, CancellationToken ct)
    {
        if(rows.Count==0)return [];
        var ids=rows.Select(row=>row.Id).ToArray();
        var parents=await db.Conversations.AsNoTracking().Where(c=>ids.Contains(c.Id)&&c.Participants.Any(p=>p.UserId==userId&&p.RemovedAt==null))
            .Select(c=>new { c.Id,c.GroupName,c.GroupAvatar, MemberCount=c.Participants.Count(p=>p.RemovedAt==null),
                Role=c.Participants.Where(p=>p.UserId==userId&&p.RemovedAt==null).Select(p=>p.Role).First() }).ToDictionaryAsync(c=>c.Id,ct);
        var allowed=parents.Keys.ToArray();
        var children=await (from link in db.CommunityGroups.AsNoTracking()
            join c in db.Conversations.AsNoTracking() on link.ConversationId equals c.Id
            where allowed.Contains(link.CommunityId)
            orderby link.LinkedAt,c.Id
            select new {link.CommunityId, Group=new CommunityGroupView(c.Id,c.GroupName??"Grupo",c.GroupAvatar,
                c.Participants.Count(p=>p.RemovedAt==null),c.Participants.Any(p=>p.UserId==userId&&p.RemovedAt==null),
                db.CommunityGroupRequests.Any(r=>r.CommunityId==link.CommunityId&&r.ConversationId==c.Id&&r.UserId==userId&&r.DeclinedAt==null),
                c.Participants.Any(p=>p.UserId==userId&&p.RemovedAt==null&&(p.Role==ParticipantRole.Owner||p.Role==ParticipantRole.Admin)),
                !c.Participants.Any(p=>p.UserId==userId&&p.RemovedAt!=null))}).ToListAsync(ct);
        var byParent=children.ToLookup(c=>c.CommunityId,c=>c.Group);
        return rows.Where(row=>parents.ContainsKey(row.Id)).Select(row=>{
            var parent=parents[row.Id];return new CommunityView(row.Id,parent.GroupName??"Comunidad",row.Description,parent.GroupAvatar,
                parent.Role.ToString(),parent.MemberCount,row.UpdatedAt,byParent[row.Id].ToList());
        }).ToList();
    }

    private static async Task CommunityNotify(ConversationRecord conversation, INivraStore store, IHubContext<NivraHub> hub, CancellationToken ct)
    {
        var ids = conversation.Participants.Where(p => p.RemovedAt == null).Select(p => p.UserId).ToArray();
        await NotifyUsers(hub, ids, "conversation.created", await ToConversationResponseAsync(conversation, store, ct));
        await NotifyUsers(hub, ids, "community.changed", new { communityId = conversation.Id });
    }
    private static async Task CommunityAddedPush(PushNotificationService push,string id,IEnumerable<string> members,CancellationToken ct)
    {
        using var budget=CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            foreach(var batch in members.Distinct(StringComparer.Ordinal).Chunk(4))
                await Task.WhenAll(batch.Select(member=>push.SendEventAsync(member,"Nivra","Te agregaron a una comunidad","community",$"nivra-community-{id}",
                    new Dictionary<string,string>{{"communityId",id},{"conversationId",id}},budget.Token)));
        }
        catch(OperationCanceledException) when (!ct.IsCancellationRequested) { /* Membership is already committed. */ }
    }

    private static string CommunityOperationId(string userId,string purpose,Guid requestId) => "con_" +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId+"\n"+purpose+"\n"+requestId.ToString("N")))).ToLowerInvariant()[..32];

    private static bool CommunityPhotoValid(string? photo)
    {
        if(string.IsNullOrEmpty(photo))return true;
        if(photo.Length>350_000)return false;
        var prefix=new[] { "data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64," }.FirstOrDefault(p=>photo.StartsWith(p,StringComparison.Ordinal));
        if(prefix==null)return false;
        var bytes=new byte[256_000];
        return Convert.TryFromBase64String(photo[prefix.Length..],bytes,out var length) && length>12 &&
            (prefix.Contains("png") ? bytes.AsSpan(0,8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10}) :
            prefix.Contains("jpeg") ? bytes[0]==255&&bytes[1]==216&&bytes[2]==255 :
            Encoding.ASCII.GetString(bytes,0,4)=="RIFF"&&Encoding.ASCII.GetString(bytes,8,4)=="WEBP");
    }
}
