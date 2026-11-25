using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

public static class GroupConversationChecks
{
    public static async Task Run(WebApplication app, IReadOnlyDictionary<string, string> tokens)
    {
        const string id = "group-permissions-check";
        const string path = "/conversations/" + id;
        const string chatPath = "/api/chats/" + id;
        const string owner = "usr-lab-alice", moderator = "usr-lab-bob", member = "usr-lab-carol", newcomer = "usr-lab-stranger";
        var start = DateTimeOffset.UtcNow.AddDays(-1);
        var count = 0;
        void Check(bool condition, string label)
        {
            if (!condition) throw new InvalidOperationException(label);
            Interlocked.Increment(ref count);
            Console.WriteLine("PASS group " + label);
        }

        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var group = new ConversationRecord { Id = id, Type = ConversationType.Group, GroupName = "Group lab", CreatedByUserId = owner, CreatedAt = start, UpdatedAt = start };
            // Persist stale legacy CanInvite to ensure the current group policy is authoritative.
            group.Participants.AddRange([
                new() { UserId = owner, Role = ParticipantRole.Owner, JoinedAt = start },
                new() { UserId = moderator, Role = ParticipantRole.Admin, JoinedAt = start.AddMinutes(2) },
                new() { UserId = member, Role = ParticipantRole.Member, CanInvite = true, JoinedAt = start.AddMinutes(1) }
            ]);
            db.Conversations.Add(group);
            db.Messages.Add(new MessageEnvelope
            {
                Id = "group-permissions-old", ConversationId = id, ClientMessageId = "group-permissions-old", SenderUserId = owner, SenderDeviceId = "dev-lab-alice", ServerReceivedAt = start,
                SharedPayloadIv = "isolated-iv", SharedPayloadCiphertext = "isolated-body",
                Recipients = [new() { UserId = owner, DeviceId = "dev-lab-alice", Ciphertext = "isolated" }, new() { UserId = member, DeviceId = "dev-lab-carol", Ciphertext = "isolated" }],
                Receipts = [new() { UserId = owner, DeviceId = "dev-lab-alice" }, new() { UserId = member, DeviceId = "dev-lab-carol" }]
            });
            await db.SaveChangesAsync();
        }

        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(45) };
        async Task<HttpResponseMessage> Request(string? actor, HttpMethod method, string url, object? body = null)
        {
            using var request = new HttpRequestMessage(method, url);
            if (actor is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens[actor]);
            if (body is not null) request.Content = JsonContent.Create(body);
            return await client.SendAsync(request);
        }
        async Task Expect(string? actor, HttpMethod method, string url, HttpStatusCode status, string label, object? body = null)
        {
            using var response = await Request(actor, method, url, body);
            Check(response.StatusCode == status, response.StatusCode == status ? label : $"{label} returned {(int)response.StatusCode}, expected {(int)status} ({await response.Content.ReadAsStringAsync()})");
        }
        async Task<List<MessageResponse>> Messages(string actor)
        {
            using var response = await Request(actor, HttpMethod.Get, path + "/messages");
            response.EnsureSuccessStatusCode();
            return (await response.Content.ReadFromJsonAsync<List<MessageResponse>>())!;
        }

        var add = new { participantUserIds = new[] { newcomer } };
        var target = path + "/participants/" + member;
        await Expect("stranger", HttpMethod.Get, path, HttpStatusCode.NotFound, "outsider cannot open the group");
        await Expect("carol", HttpMethod.Post, path + "/participants", HttpStatusCode.Forbidden, "stale invite permission cannot override admin-only admission", add);
        await Expect("carol", HttpMethod.Post, chatPath + "/clear", HttpStatusCode.Forbidden, "ordinary member cannot clear chat for everybody", new { scope = "everyone" });
        await Expect("bob", HttpMethod.Delete, chatPath + "?scope=everyone", HttpStatusCode.Forbidden, "moderator cannot delete group for everybody");
        await Expect("carol", HttpMethod.Delete, path + "/participants/" + moderator, HttpStatusCode.Forbidden, "ordinary member cannot remove the moderator");
        await Expect("bob", HttpMethod.Delete, path + "/participants/" + owner, HttpStatusCode.Forbidden, "moderator cannot remove the owner");
        await Expect("carol", HttpMethod.Put, path + "/roles/participant", HttpStatusCode.Forbidden, "ordinary member cannot promote themself", new { participantUserId = member, admin = true });
        await Expect("alice", HttpMethod.Post, path + "/delete-request", HttpStatusCode.Conflict, "legacy endpoint cannot orphan a group", new { requestRemoteDelete = false });
        await Expect("alice", HttpMethod.Put, path + "/roles", HttpStatusCode.BadRequest, "legacy role replacement rejects a body missing the admin list", new { participantUserId = member, admin = true });
        await Expect("alice", HttpMethod.Put, path + "/roles", HttpStatusCode.OK, "legacy clients can still send the full list of administrators", new { adminUserIds = new[] { moderator } });

        var admissions = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using var response = await Request("alice", HttpMethod.Post, path + "/participants", add);
            response.EnsureSuccessStatusCode();
            return (await response.Content.ReadFromJsonAsync<ConversationResponse>())!.Participants.Single(participant => participant.UserId == newcomer);
        }));
        Check(admissions.All(participant => participant.Role == ParticipantRole.Member && participant.RemovedAt is null), "overlapping admissions each confirm one active ordinary member");
        Check(admissions.Select(participant => participant.JoinedAt).Distinct().Count() == 1, "admission retries preserve the original join boundary");
        Check((await Messages("stranger")).Count == 0, "a newly added member receives no earlier encrypted traffic by default");
        Check((await Messages("carol")).Any(message => message.Id == "group-permissions-old"), "old participant still sees their eligible history");
        const string receiptPath = "/messages/group-permissions-old/receipt";
        var receipt = new ReceiptRequest(ReceiptKind.Delivered, null);
        using (var response = await Request("carol", HttpMethod.Post, receiptPath, receipt))
        {
            response.EnsureSuccessStatusCode();
            var details = (await response.Content.ReadFromJsonAsync<MessageResponse>())!;
            Check(details.Recipients.Count == 0 && details.SharedPayloadCiphertext is null && details.SharedPayloadIv is null &&
                details.Receipts.Single(row => row.UserId == member).DeliveredAt is not null, "delivery receipt reports status without returning any encrypted payload");
        }
        await Expect("carol", HttpMethod.Post, chatPath + "/clear", HttpStatusCode.OK, "ordinary member may clear only their own receipts", new { scope = "me" });
        Check((await Messages("carol")).Count == 0 && (await Messages("alice")).Count == 1, "personal clear leaves other members' receipts intact");

        var allMayInvite = new { settings = new GroupSettings { AddMembers = "all" } };
        await Expect("alice", HttpMethod.Patch, path, HttpStatusCode.OK, "owner can allow active members to invite", allMayInvite);
        await Expect("bob", HttpMethod.Delete, target, HttpStatusCode.OK, "moderator removes ordinary member");
        await Expect("bob", HttpMethod.Delete, target, HttpStatusCode.OK, "removal retry is idempotent");
        await Expect("carol", HttpMethod.Get, path + "/messages", HttpStatusCode.NotFound, "removed member immediately loses group history access");
        await Expect("carol", HttpMethod.Post, receiptPath, HttpStatusCode.NotFound, "former member cannot use an old receipt to access the group message", receipt);
        var rejoin = new { participantUserIds = new[] { member } };
        await Expect("stranger", HttpMethod.Post, path + "/participants", HttpStatusCode.Forbidden, "member invite permission cannot reverse a removal", rejoin);
        using (var response = await Request("alice", HttpMethod.Post, path + "/participants", rejoin))
        {
            response.EnsureSuccessStatusCode();
            var admitted = (await response.Content.ReadFromJsonAsync<ConversationResponse>())!.Participants.Single(participant => participant.UserId == member);
            Check(admitted.JoinedAt > start && admitted.RemovedAt is null && admitted.Role == ParticipantRole.Member, "owner readmission starts a fresh ordinary membership");
        }

        await Task.WhenAll(
            Expect("alice", HttpMethod.Put, path + "/roles/participant", HttpStatusCode.OK, "owner promotes a member by ID", new { participantUserId = member, admin = true }),
            Expect("bob", HttpMethod.Put, path + "/roles/participant", HttpStatusCode.OK, "moderator promotes a different member concurrently", new { participantUserId = newcomer, admin = true }));
        using (var response = await Request("alice", HttpMethod.Get, path))
        {
            var group = (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
            Check(group.GroupManagementVersion == 1, "conversation advertises the availability of scoped role changes and history sharing");
            Check(group.Participants.Count(participant => participant.Role == ParticipantRole.Admin) == 3, "parallel role updates preserve both changes");
        }
        await Expect("bob", HttpMethod.Delete, target, HttpStatusCode.Forbidden, "moderator cannot remove a peer moderator");
        await Expect("bob", HttpMethod.Post, chatPath + "/clear", HttpStatusCode.OK, "moderator can clear chat for all participants", new { scope = "everyone" });
        Check((await Messages("alice")).Count == 0, "moderator clear marks remaining receipts in PostgreSQL");
        await Expect("alice", HttpMethod.Post, path + "/leave", HttpStatusCode.OK, "owner can leave the group");
        await Expect("alice", HttpMethod.Post, path + "/leave", HttpStatusCode.NoContent, "leave retry stays successful");
        using (var response = await Request("bob", HttpMethod.Get, path))
        {
            var group = (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
            Check(group.Participants.Single(participant => participant.Role == ParticipantRole.Owner).UserId == moderator, "owner departure preserves ownership using an existing moderator");
        }
        await Expect("bob", HttpMethod.Delete, chatPath + "?scope=everyone", HttpStatusCode.NoContent, "new owner can remove an ordinary group for everybody");
        await Expect("carol", HttpMethod.Get, path, HttpStatusCode.NotFound, "whole-group deletion closes access for remaining members");
        Console.WriteLine($"{count} group authorization and concurrency checks passed.");
    }
}
