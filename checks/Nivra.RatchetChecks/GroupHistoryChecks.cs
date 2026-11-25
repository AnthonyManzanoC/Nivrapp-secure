using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

internal static class GroupHistoryChecks
{
    public static async Task Run(WebApplication app, IReadOnlyDictionary<string, string> tokens)
    {
        const string chatId = "group-history-fixture", author = "usr-lab-alice", newcomer = "usr-lab-bob", existing = "usr-lab-carol";
        const string authorDevice = "dev-lab-alice-hybrid", newcomerDevice = "dev-lab-bob-hybrid", otherDevice = "dev-lab-carol";
        const string sourceId = "group-history-source", ephemeral = "group-history-ephemeral", viewed = "group-history-view-once", removed = "group-history-deleted";
        var now = DateTimeOffset.UtcNow;
        var joined = DateTimeOffset.FromUnixTimeMilliseconds(now.AddMinutes(-1).ToUnixTimeMilliseconds());
        RatchetPilotDevice registration;
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var group = new ConversationRecord
            {
                Id = chatId, Type = ConversationType.Group, CreatedByUserId = author, CreatedAt = now.AddDays(-1), UpdatedAt = now
            };
            group.Participants.AddRange([
                new() { UserId = author, Role = ParticipantRole.Owner, JoinedAt = group.CreatedAt },
                new() { UserId = existing, Role = ParticipantRole.Member, JoinedAt = group.CreatedAt },
                new() { UserId = newcomer, Role = ParticipantRole.Member, JoinedAt = joined }
            ]);
            db.Conversations.Add(group);
            foreach (var id in new[] { sourceId, ephemeral, viewed, removed })
            {
                db.Messages.Add(new MessageEnvelope
                {
                    Id = id, ClientMessageId = "original-" + id, ConversationId = chatId, SenderUserId = author,
                    SenderDeviceId = authorDevice, Kind = MessageKind.Text, ServerReceivedAt = now.AddMinutes(-10),
                    ExpiresAt = id == ephemeral ? now.AddHours(1) : null, DeleteAfterRead = id == viewed,
                    Recipients = [new() { UserId = author, DeviceId = authorDevice, Ciphertext = "original" },
                        new() { UserId = existing, DeviceId = otherDevice, Ciphertext = "original" }],
                    Receipts = [new() { UserId = author, DeviceId = authorDevice, DeletedAt = id == removed ? now : null }]
                });
            }
            await db.SaveChangesAsync();
            registration = await db.Set<RatchetPilotDevice>().SingleAsync(device => device.DeviceId == authorDevice);
        }

        string B64(int length) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(length));
        var admission = FormattableString.Invariant($"{chatId}\u001f{newcomer}\u001f{joined.ToUnixTimeMilliseconds()}");
        var key = "group-history:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(admission)));
        var digest = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(key))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var selfHeader = JsonSerializer.Serialize(new { v = 4, alg = RatchetMessagePolicy.HybridAlgorithm, senderDeviceId = authorDevice,
            recipientDeviceId = authorDevice, identityKey = registration.IdentityKey, registrationId = registration.RegistrationId, local = true });
        var header = JsonSerializer.Serialize(new { v = 4, alg = RatchetMessagePolicy.HybridAlgorithm, senderDeviceId = authorDevice,
            recipientDeviceId = newcomerDevice, identityKey = registration.IdentityKey, registrationId = registration.RegistrationId,
            payloadIv = B64(12), payloadCiphertext = B64(32) });
        var ciphertext = JsonSerializer.Serialize(new { v = 3, suite = "NIVRA-PQXDH-MLKEM768-A256GCM-1", type = 3,
            keyMessage = B64(32), iv = B64(12), ciphertext = B64(32),
            context = new { conversationId = chatId, messageId = digest, sender = authorDevice + ".1", recipient = newcomerDevice + ".1" } });
        var frame = new SendMessageRequest(key, MessageKind.Text,
            [new(author, authorDevice, "local-history-v1", selfHeader, null), new(newcomer, newcomerDevice, ciphertext, header, null)],
            null, null, false, GroupHistory: new(newcomer, [sourceId]));
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(45) };
        var conversationPath = $"/conversations/{chatId}/messages";
        var sendPath = conversationPath + "/group-history/ratchet";

        async Task<HttpResponseMessage> Request(HttpMethod method, string actor, string path, object? body = null)
        {
            using var request = new HttpRequestMessage(method, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens[actor]);
            if (body is not null) request.Content = JsonContent.Create(body);
            return await client.SendAsync(request);
        }
        static void Check(bool success, string message)
        {
            if (!success) throw new InvalidOperationException(message);
            Console.WriteLine("PASS " + message);
        }

        using (var unshared = await Request(HttpMethod.Get, "bob-hybrid", conversationPath))
            Check(unshared.IsSuccessStatusCode && (await unshared.Content.ReadFromJsonAsync<List<MessageResponse>>())?.Count == 0,
                "new group members receive no pre-admission ciphertext by default");
        using (var noPermission = await Request(HttpMethod.Post, "carol", sendPath, frame))
            Check(noPermission.StatusCode == HttpStatusCode.Forbidden, "members without admin rights cannot share a history summary");
        using (var bypass = await Request(HttpMethod.Post, "alice-hybrid", conversationPath + "/ratchet", frame with { GroupHistory = null }))
            Check(bypass.StatusCode == HttpStatusCode.BadRequest, "a summary key cannot bypass permissions through regular send");
        using (var additional = await Request(HttpMethod.Post, "alice-hybrid", sendPath,
            frame with { Recipients = [.. frame.Recipients, new(existing, otherDevice, "bogus", null, null)] }))
            Check(additional.StatusCode == HttpStatusCode.BadRequest, "history envelopes cannot be sent to unselected group members");
        foreach (var protectedId in new[] { ephemeral, viewed, removed })
        {
            using var denied = await Request(HttpMethod.Post, "alice-hybrid", sendPath, frame with { GroupHistory = new(newcomer, [protectedId]) });
            Check(denied.StatusCode == HttpStatusCode.Conflict, $"history skips protected source {protectedId}");
        }

        string summaryId;
        using (var sent = await Request(HttpMethod.Post, "alice-hybrid", sendPath, frame))
        {
            Check(sent.StatusCode == HttpStatusCode.Created, "administrator can explicitly send a new encrypted summary to the recent member");
            summaryId = (await sent.Content.ReadFromJsonAsync<MessageResponse>())!.Id;
        }
        var retries = await Task.WhenAll(Enumerable.Range(0, 6).Select(async _ =>
        {
            using var retry = await Request(HttpMethod.Post, "alice-hybrid", sendPath, frame);
            return retry.StatusCode == HttpStatusCode.OK && (await retry.Content.ReadFromJsonAsync<MessageResponse>())?.Id == summaryId;
        }));
        Check(retries.All(success => success), "concurrent summary retries acknowledge the same persisted envelope");
        using (var received = await Request(HttpMethod.Get, "bob-hybrid", conversationPath))
        {
            received.EnsureSuccessStatusCode();
            var rows = await received.Content.ReadFromJsonAsync<List<MessageResponse>>();
            Check(rows?.Count == 1 && rows[0].Id == summaryId && rows[0].Recipients.All(envelope => envelope.UserId == newcomer),
                "the new member sees only the deliberately shared summary addressed to their device");
        }
        using (var excluded = await Request(HttpMethod.Get, "carol", conversationPath))
        {
            excluded.EnsureSuccessStatusCode();
            Check((await excluded.Content.ReadFromJsonAsync<List<MessageResponse>>())?.Any(row => row.Id == summaryId) == false,
                "a current but unselected group member cannot read the history summary");
        }
        using (var receipt = await Request(HttpMethod.Post, "carol", $"/messages/{summaryId}/receipt", new ReceiptRequest(ReceiptKind.Delivered, null)))
            Check(receipt.StatusCode == HttpStatusCode.NotFound, "unselected group members cannot claim the summary delivery receipt");
    }
}
