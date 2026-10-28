using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

var checks = 0;
void Check(bool ok, string name) { if (!ok) throw new InvalidOperationException(name); Console.WriteLine("PASS " + name); checks++; }
var name = "blocks-fixture-" + Guid.NewGuid();
var capture = new CaptureHub();
var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddDbContext<NivraDbContext>(options => options.UseInMemoryDatabase(name));
builder.Services.AddScoped<INivraStore, PgSqlNivraStore>();
builder.Services.AddSingleton<IHubContext<NivraHub>>(capture); builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<RealtimePresence>(); builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddHttpClient(); builder.Services.AddDataProtection(); builder.Services.Configure<NivraPushOptions>(_ => { });
builder.Services.AddSingleton<PushNotificationService>();
await using var app = builder.Build();
app.Use(async (http, next) => { if (http.Request.Headers.TryGetValue("X-Fixture-Account", out var account)) http.Items["__nivra_current_user"] = new CurrentUser(account.ToString(), "fixture-device", "fixture-session"); await next(http); });
app.MapContactBlockEndpoints();
foreach (var method in new[] { "MapConversationAndMessageEndpoints", "MapCallEndpoints" })
    typeof(EndpointExtensions).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [app]);
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    foreach (var id in new[] { "alice", "bob", "carol" }) db.Users.Add(new UserAccount { Id = id, Alias = id, NivraNumber = id == "alice" ? "111111111" : id == "bob" ? "222222222" : "333333333", PasswordHash = new() });
    var direct = new ConversationRecord { Id = "direct", Type = ConversationType.Direct, CreatedByUserId = "alice" };
    direct.Participants.Add(new() { UserId = "alice" }); direct.Participants.Add(new() { UserId = "bob" }); db.Conversations.Add(direct);
    var group = new ConversationRecord { Id = "shared-group", Type = ConversationType.Group, CreatedByUserId = "alice" };
    group.Participants.Add(new() { UserId = "alice" }); group.Participants.Add(new() { UserId = "bob" }); db.Conversations.Add(group);
    foreach (var item in new[] { (Id: "old-active", Conversation: "direct", Peer: "bob", Status: CallStatus.Active),
        (Id: "old-ringing", Conversation: (string?)null, Peer: "bob", Status: CallStatus.Ringing),
        (Id: "old-group", Conversation: "shared-group", Peer: "bob", Status: CallStatus.Active),
        (Id: "unrelated", Conversation: (string?)null, Peer: "carol", Status: CallStatus.Active) })
    {
        var call = new CallSession { Id = item.Id, ConversationId = item.Conversation, InitiatorUserId = "alice", Type = CallType.Voice,
            Status = item.Status, ParticipantUserIds = ["alice", item.Peer], StartedAt = DateTimeOffset.UtcNow };
        call.ParticipantSessions["alice"] = new("alice-device", "alice-tab");
        if (item.Status == CallStatus.Active) call.ParticipantSessions[item.Peer] = new(item.Peer + "-device", "peer-tab");
        db.Calls.Add(call);
        db.CallPushOutbox.Add(new() { CallId = call.Id, RecipientUserId = item.Peer, CreatedAt = call.StartedAt, ExpiresAt = call.StartedAt.AddSeconds(75), NextAttemptAt = call.StartedAt });
    }
    await db.SaveChangesAsync();
}
await app.StartAsync();
using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
async Task<HttpResponseMessage> Request(HttpMethod method, string path, string? owner, object? body = null)
{
    using var request = new HttpRequestMessage(method, path); if (owner is not null) request.Headers.Add("X-Fixture-Account", owner);
    if (body is not null) request.Content = JsonContent.Create(body);
    return await client.SendAsync(request);
}
Check((await Request(HttpMethod.Get, "/contacts/blocks", null)).StatusCode == HttpStatusCode.Unauthorized, "private block list requires an authenticated account");
Check((await Request(HttpMethod.Put, "/contacts/bob/block", null, new { blocked = true })).StatusCode == HttpStatusCode.Unauthorized, "anonymous account cannot create a block");
Check((await Request(HttpMethod.Put, "/contacts/alice/block", "alice", new { blocked = true })).StatusCode == HttpStatusCode.NotFound, "self block is rejected");
Check((await Request(HttpMethod.Put, "/contacts/unknown/block", "alice", new { blocked = true })).StatusCode == HttpStatusCode.NotFound, "nonexistent contact does not create a dangling row");
var response = await Request(HttpMethod.Put, "/contacts/bob/block", "alice", new { blocked = true });
Check(response.IsSuccessStatusCode && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("blocked").GetBoolean(), "real HTTP route confirms account-level blocking");
Check(response.Headers.CacheControl?.NoStore == true, "sensitive acknowledgement cannot be cached");
Check(capture.Messages.Count(item => item.Method == "contacts.blocksChanged") == 1 && capture.Messages.Single(item => item.Method == "contacts.blocksChanged").Group == "user:alice", "only owner's devices receive the invalidation; blocked account gets no disclosure");
Check(capture.Messages.Count(item => item.Method == "call.ended" && item.Group == "user:alice") == 2 && capture.Messages.Count(item => item.Method == "call.ended" && item.Group == "user:bob") == 2, "active and ringing direct calls emit termination to both accounts without disclosing the block");
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    var ended = await db.Calls.Where(call => call.Id == "old-active" || call.Id == "old-ringing").ToListAsync();
    Check(ended.All(call => call.Status == CallStatus.Ended && call.EndedAt is not null && call.ParticipantSessions.Count == 0), "blocking clears existing direct media owners and cannot leave a stale Active call");
    Check(await db.Calls.CountAsync(call => call.Status == CallStatus.Active && call.EndedAt == null) == 2, "shared group and unrelated peer calls continue without being terminated");
    Check((await db.CallPushOutbox.Where(row => row.CallId == "old-active" || row.CallId == "old-ringing").ToListAsync()).All(row => row.CompletedAt is not null && row.LeaseId is null), "direct call outbox notices finish atomically with closure and cannot retry later");
    Check((await db.CallPushOutbox.Where(row => row.CallId == "old-group" || row.CallId == "unrelated").ToListAsync()).All(row => row.CompletedAt is null), "blocking does not clear another conversation's pending invitations");
}
await Request(HttpMethod.Put, "/contacts/bob/block", "alice", new { blocked = true });
Check((await (await Request(HttpMethod.Get, "/contacts/blocks", "alice")).Content.ReadFromJsonAsync<string[]>())!.SequenceEqual(["bob"]), "idempotent repeated blocking persists exactly one private row");
Check((await (await Request(HttpMethod.Get, "/contacts/blocks?owner=alice", "bob")).Content.ReadFromJsonAsync<string[]>())!.Length == 0, "query parameters cannot expose another account's private list");
await Request(HttpMethod.Put, "/contacts/alice/block", "bob", new { blocked = false });
Check((await (await Request(HttpMethod.Get, "/contacts/blocks", "alice")).Content.ReadFromJsonAsync<string[]>())!.Length == 1, "counterpart cannot remove the owner's block");
var invalidMessage = new { clientMessageId = "", recipients = Array.Empty<object>() };
foreach (var actor in new[] { "alice", "bob" })
{
    response = await Request(HttpMethod.Post, "/conversations/direct/messages", actor, invalidMessage);
    Check(response.StatusCode == HttpStatusCode.Forbidden && (await response.Content.ReadAsStringAsync()).Contains("communication_unavailable"), "direct message HTTP gate rejects " + actor + " without revealing who blocked whom");
    response = await Request(HttpMethod.Post, "/calls/start", actor, new { type = "Voice", conversationId = "direct", clientSessionId = "test-session", clientProtocol = 2 });
    Check(response.StatusCode == HttpStatusCode.Forbidden, "direct call HTTP start rejects " + actor);
    response = await Request(HttpMethod.Post, "/conversations", actor, new { type = "Direct", participantUserIds = new[] { "alice", "bob" } });
    Check(response.StatusCode == HttpStatusCode.Forbidden, "creating another direct thread cannot bypass contact block for " + actor);
}
Check((await Request(HttpMethod.Post, "/conversations/direct/messages", "carol", invalidMessage)).StatusCode == HttpStatusCode.NotFound, "block lookup does not grant a nonparticipant access to a conversation");
Check((await Request(HttpMethod.Post, "/conversations/shared-group/messages", "bob", invalidMessage)).StatusCode == HttpStatusCode.BadRequest, "shared group still reaches its ordinary validation rather than contact block gate");
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    var call = new CallSession { Id = "fixture-call", InitiatorUserId = "alice", Type = CallType.Video, Status = CallStatus.Ringing, ParticipantUserIds = ["alice", "bob"] };
    Check(await ContactBlockPolicy.BlocksCallAsync(db, call, default), "conversationless direct calls cannot bypass blocking");
    call.ConversationId = "shared-group";
    Check(!await ContactBlockPolicy.BlocksCallAsync(db, call, default), "two-person group room retains shared-group exception");
    foreach (var type in new[] { "message", "incoming_call", "missed_call", "conversation" })
        Check(await ContactBlockPolicy.SuppressPushAsync(db, "alice", new Dictionary<string, string> { ["type"] = type, ["senderUserId"] = "bob", ["callerUserId"] = "bob", ["conversationId"] = "direct" }, default), "queued " + type + " notice is suppressed after block before provider delivery");
    Check(!await ContactBlockPolicy.SuppressPushAsync(db, "alice", new Dictionary<string, string> { ["type"] = "incoming_call", ["callerUserId"] = "bob", ["conversationId"] = "shared-group" }, default), "group invitation remains deliverable");
    Check(!await ContactBlockPolicy.SuppressPushAsync(db, "alice", new Dictionary<string, string> { ["type"] = "end_call", ["callerUserId"] = "bob" }, default), "termination control still clears an existing native ringing notification");
    Check(!await ContactBlockPolicy.BetweenAsync(db, "alice", "carol", default), "unrelated peer is not blocked");
    foreach (var actor in new[] { "alice", "bob" })
    {
        var hub = new NivraHub(null!, new PgSqlNivraStore(db), db, null!, new RealtimePresence(), null!, null!,
            new LiveKitTokenService(Options.Create(new LiveKitOptions()), TimeProvider.System), NullLogger<NivraHub>.Instance, TimeProvider.System)
            { Context = new FixtureHubContext(actor) };
        try
        {
            await hub.CallUser(new Nivra.Api.Contracts.StartCallRequest(CallType.Voice, "direct", null, "test-session", ClientProtocol: 2));
            Check(false, "SignalR cannot bypass direct block for " + actor);
        }
        catch (HubException error) { Check(error.Message == "No se puede iniciar esta llamada.", "SignalR CallUser independently enforces direct block for " + actor); }
    }
}
await Request(HttpMethod.Put, "/contacts/bob/block", "alice", new { blocked = false });
Check((await (await Request(HttpMethod.Get, "/contacts/blocks", "alice")).Content.ReadFromJsonAsync<string[]>())!.Length == 0, "unblock from another session of the owner is synchronized through the same HTTP state");
Check((await Request(HttpMethod.Post, "/conversations/direct/messages", "bob", invalidMessage)).StatusCode == HttpStatusCode.BadRequest, "unblock restores normal direct message validation instead of retaining the block gate");
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    Check(!await ContactBlockPolicy.BetweenAsync(db, "alice", "bob", default), "confirmed unblock restores pair policy without replaying old messages");
    Check(!await db.Messages.AnyAsync() && await db.Calls.CountAsync() == 4, "rejected operations persist neither envelopes nor phantom calls");
}
await app.StopAsync();
await using var sqlDb = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>().UseNpgsql("Host=127.0.0.1;Port=1;Database=offline;Username=offline;Password=offline").Options);
Check(!sqlDb.Database.HasPendingModelChanges(), "migration snapshot matches actual contact block model");
var migration = sqlDb.GetService<IMigrator>().GenerateScript("20261027112327_DurableCallPushOutbox", "20261028004053_AccountContactBlocks");
Check(migration.Contains("CREATE TABLE public.contact_blocks") && migration.Contains("IX_contact_blocks_ContactUserId_OwnerUserId") && !migration.Contains("DROP TABLE"), "additive migration preserves histories and indexes reverse-direction checks");
Check(ContactBlockPolicy.LockKey("alice", "bob") == ContactBlockPolicy.LockKey("bob", "alice") && ContactBlockPolicy.LockKey("alice", "bob") != ContactBlockPolicy.LockKey("alice", "carol"), "block edits and direct sending share the same unambiguous pair lock");
Console.WriteLine($"{checks} contact blocking checks passed (isolated local HTTP fixtures; no live accounts).");

public sealed class CaptureHub : IHubContext<NivraHub>
{
    public List<(string Group, string Method)> Messages { get; } = [];
    public IHubClients Clients { get; }
    public IGroupManager Groups => throw new NotSupportedException();
    public CaptureHub() { Clients = DispatchProxy.Create<IHubClients, HubClientsProxy>(); ((HubClientsProxy)Clients).ForGroup = group => new CaptureClient(group, Messages); }
}
public class HubClientsProxy : DispatchProxy
{
    public Func<string, IClientProxy> ForGroup { get; set; } = null!;
    protected override object? Invoke(MethodInfo? target, object?[]? args) => target?.Name == "Group" ? ForGroup((string)args![0]!) : throw new NotSupportedException(target?.Name);
}
public sealed class CaptureClient(string group, List<(string Group, string Method)> messages) : IClientProxy
{
    public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default) { messages.Add((group, method)); return Task.CompletedTask; }
}
public sealed class FixtureHubContext(string account) : HubCallerContext
{
    public override string ConnectionId => "fixture-connection";
    public override string? UserIdentifier => account;
    public override System.Security.Claims.ClaimsPrincipal? User => null;
    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?> { ["current_user"] = new CurrentUser(account, "fixture-device", "fixture-session") };
    public override IFeatureCollection Features { get; } = new FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}
