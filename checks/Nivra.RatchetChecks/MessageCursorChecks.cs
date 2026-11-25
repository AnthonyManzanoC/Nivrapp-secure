using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

internal static class MessageCursorChecks
{
    public static async Task Run(WebApplication app, IReadOnlyDictionary<string, string> tokens, bool measure)
    {
        const string conversationId = "sync-cursor-fixture";
        const string sender = "usr-lab-alice";
        const string recipient = "usr-lab-bob";
        const string device = "dev-lab-bob-hybrid";
        var timestamp = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).AddMinutes(5);
        var count = measure ? 4096 : 130;
        var ids = Enumerable.Range(0, count).Select(index => $"msg-scale-{index:D5}").ToList();
        ids.AddRange(["msg-scale-A", "msg-scale-a"]);
        const string expired = "msg-scale-expired";
        const string deleted = "msg-scale-deleted";
        const string later = "msg-scale-later";
        const string earlier = "msg-scale-earlier";

        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            db.ChangeTracker.AutoDetectChangesEnabled = false;
            var conversation = new ConversationRecord
            {
                Id = conversationId, Type = ConversationType.Group, CreatedByUserId = sender,
                CreatedAt = timestamp.AddDays(-1), UpdatedAt = timestamp
            };
            conversation.Participants.AddRange([
                new() { UserId = sender, JoinedAt = timestamp.AddDays(-1) },
                new() { UserId = recipient, JoinedAt = timestamp.AddDays(-1) },
                new() { UserId = "usr-lab-carol", JoinedAt = timestamp.AddDays(-1), RemovedAt = timestamp.AddMinutes(-1) }
            ]);
            db.Conversations.Add(conversation);
            foreach (var id in ids.Concat([expired, deleted, later, earlier]))
            {
                db.Messages.Add(new MessageEnvelope
                {
                    Id = id, ClientMessageId = id, ConversationId = conversationId, SenderUserId = sender,
                    SenderDeviceId = "dev-lab-alice-hybrid", ServerReceivedAt = id switch
                    {
                        later => timestamp.AddSeconds(1), earlier => timestamp.AddSeconds(-1), _ => timestamp
                    },
                    ExpiresAt = id == expired ? timestamp.AddMinutes(-10) : null,
                    SharedPayloadCiphertext = new string('c', 768),
                    Recipients = [
                        new() { UserId = recipient, DeviceId = device, Header = "fixture", Ciphertext = "opaque" },
                        new() { UserId = "usr-lab-carol", DeviceId = "dev-lab-carol", Header = "fixture", Ciphertext = "opaque" }
                    ],
                    Receipts = [
                        new() { UserId = recipient, DeviceId = device, DeletedAt = id == deleted ? timestamp : null },
                        new() { UserId = "usr-lab-carol", DeviceId = "dev-lab-carol" }
                    ]
                });
            }
            await db.SaveChangesAsync();
        }

        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(45) };
        async Task<HttpResponseMessage> Read(string? actor, DateTimeOffset? since, string? cursor, int size, bool composite = true)
        {
            var path = $"/messages/sync?take={size}";
            if (composite) path += "&cursorVersion=2";
            if (since is { } watermark) path += "&since=" + Uri.EscapeDataString(watermark.ToString("O", CultureInfo.InvariantCulture));
            if (cursor is not null) path += "&sinceId=" + Uri.EscapeDataString(cursor);
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (actor is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens[actor]);
            return await client.SendAsync(request);
        }

        static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
            Console.WriteLine("PASS " + message);
        }
        using (var anonymous = await Read(null, timestamp, null, 100))
            Check(anonymous.StatusCode == HttpStatusCode.Unauthorized, "sync pages require an authenticated device");
        foreach (var actor in new[] { "carol", "stranger" })
        {
            using var response = await Read(actor, timestamp, null, 100);
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>();
            Check(page is not null && page.Messages.Count == 0, $"sync does not return protected group envelopes to {actor}");
        }

        var ordered = ids.Order(StringComparer.Ordinal).Append(later).ToArray();
        using (var response = await Read("bob-hybrid", null, null, 2))
        {
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>();
            Check(page is not null && page.CursorId == later && page.HasMore == false
                && page.Messages.Select(row => row.Id).SequenceEqual(ordered.TakeLast(2)), "first sync page returns the newest messages in chronological order");
        }
        using (var response = await Read("bob-hybrid", timestamp, "msg-scale-04000", 100, composite: false))
        {
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>();
            Check(page is not null && page.CursorId is null && page.HasMore is null
                && page.Messages.Select(row => row.Id).SequenceEqual([later]), "legacy clients continue from a timestamp without cursor fields");
        }
        using (var response = await Read("bob-hybrid", timestamp, deleted, 100))
        {
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>();
            Check(page is not null && page.Messages.Select(row => row.Id).SequenceEqual([later]),
                "a deleted cursor still moves to the next timestamp");
        }
        var seen = new List<string>();
        DateTimeOffset since = timestamp;
        string? cursor = "msg-scale-!";
        for (var pageNumber = 0; pageNumber <= ordered.Length / 100 + 1; pageNumber++)
        {
            using var response = await Read("bob-hybrid", since, cursor, 100);
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>() ?? throw new InvalidOperationException("Missing sync page");
            if (page.Messages.Count > 100 || page.Messages.Any(row => row.Recipients.Any(envelope => envelope.UserId != recipient)))
                throw new InvalidOperationException("A sync page exceeded its bound or included another user's ciphertext.");
            seen.AddRange(page.Messages.Select(row => row.Id));
            if (page.HasMore != true) break;
            since = page.SyncedAt;
            cursor = page.CursorId;
        }
        Check(seen.SequenceEqual(ordered), "sync pages preserve ordinal order and cross timestamp ties with zero missing, duplicated, deleted or expired messages");

        async Task<HttpResponseMessage> ReadHistory(string actor, MessageResponse? boundary, bool includeId = true)
        {
            var path = $"/conversations/{conversationId}/messages?take=100";
            if (boundary is not null)
            {
                path += "&before=" + Uri.EscapeDataString(boundary.ServerReceivedAt.ToString("O", CultureInfo.InvariantCulture));
                if (includeId) path += "&beforeId=" + Uri.EscapeDataString(boundary.Id);
            }
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens[actor]);
            return await client.SendAsync(request);
        }

        using (var response = await ReadHistory("carol", null))
            Check(response.StatusCode == HttpStatusCode.NotFound, "conversation history is unavailable to removed members");

        var reverse = new List<string>();
        MessageResponse? before = null;
        for (var pageNumber = 0; pageNumber <= ordered.Length / 100 + 1; pageNumber++)
        {
            using var response = await ReadHistory("bob-hybrid", before);
            response.EnsureSuccessStatusCode();
            var rows = await response.Content.ReadFromJsonAsync<List<MessageResponse>>() ?? throw new InvalidOperationException("Missing history page");
            if (rows.Count == 0) break;
            if (rows.Count > 100 || rows.Any(row => row.Recipients.Any(envelope => envelope.UserId != recipient)))
                throw new InvalidOperationException("Conversation history disclosed another user's ciphertext or exceeded its bound.");
            reverse.AddRange(rows.AsEnumerable().Reverse().Select(row => row.Id));
            before = rows[0];
        }
        Check(reverse.SequenceEqual(ordered.Reverse().Append(earlier)), "conversation history goes backward through ties without missing, duplicating or returning protected rows");
        using (var response = await ReadHistory("bob-hybrid", before, includeId: false))
        {
            response.EnsureSuccessStatusCode();
            Check((await response.Content.ReadFromJsonAsync<List<MessageResponse>>())?.Count == 0,
                "legacy conversation history uses a strict timestamp boundary");
        }
        if (!measure) return;

        var samples = new List<double>();
        for (var index = 0; index < 15; index++)
        {
            var start = Stopwatch.GetTimestamp();
            using var response = await Read("bob-hybrid", timestamp, "msg-scale-04000", 30);
            response.EnsureSuccessStatusCode();
            var page = await response.Content.ReadFromJsonAsync<MessageSyncResponse>();
            if (page?.Messages.Count != 30) throw new InvalidOperationException("Unexpected perf page size.");
            samples.Add(Stopwatch.GetElapsedTime(start).TotalMilliseconds);
        }
        samples.Sort();
        await Parallel.ForEachAsync(Enumerable.Range(0, 32), new ParallelOptions { MaxDegreeOfParallelism = 8 }, async (_, _) =>
        {
            using var response = await Read("bob-hybrid", timestamp, "msg-scale-04000", 30);
            response.EnsureSuccessStatusCode();
            if ((await response.Content.ReadFromJsonAsync<MessageSyncResponse>())?.Messages.Count != 30)
                throw new InvalidOperationException("Concurrent sync returned a partial page.");
        });
        Console.WriteLine(FormattableString.Invariant(
            $"SYNC_LOAD tiedEnvelopes={ids.Count} samples={samples.Count} p50Ms={samples[samples.Count/2]:F1} maxMs={samples[^1]:F1} concurrentReads=32 concurrency=8 errors=0"));
    }
}
