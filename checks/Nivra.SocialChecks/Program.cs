using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;

var checks = 0;
void Check(bool result, string name) { if (!result) throw new InvalidOperationException(name); checks++; Console.WriteLine($"PASS {name}"); }
object? Invoke(string name, params object?[] args) => typeof(EndpointExtensions).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, args);
var now = DateTimeOffset.UtcNow;
UserAccount Person(string id, bool discoverable = true) => new() { Id = id, Alias = id, DisplayName = id + " Name", NivraNumber = id == "alice" ? "123456789" : "987654321",
    PasswordHash = new PasswordHash(), Phone = "+19990000000", ProfilePhotoDataUrl = "data:image/png;base64,private-" + id, IsDiscoverable = discoverable, CreatedAt = now, UpdatedAt = now };
ContactRecord Contact(string owner, string target) => new() { Id = owner + ":" + target, OwnerUserId = owner, ContactUserId = target, CreatedAt = now };
FriendRequestRecord Request(string id, string from, string to, FriendRequestStatus status = FriendRequestStatus.Pending, int seconds = 0) =>
    new() { Id = id, FromUserId = from, ToUserId = to, Status = status, CreatedAt = now.AddSeconds(seconds), UpdatedAt = now.AddSeconds(seconds) };

await using var db = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>().UseInMemoryDatabase("social-checks-" + Guid.NewGuid()).Options);
var alice = Person("alice"); var bob = Person("bob", false); var carol = Person("carol");
alice.PrivacySettings.ProfilePhotoVisibility = "contacts";
bob.PrivacySettings.ProfilePhotoVisibility = "nobody";
db.Users.AddRange(alice, bob, carol); await db.SaveChangesAsync();
var store = new PgSqlNivraStore(db);
async Task<UserSummaryResponse> Summary(UserAccount owner, string viewer) => await (Task<UserSummaryResponse>)Invoke("ToUserSummaryAsync", owner, viewer, db, CancellationToken.None)!;
async Task<ContactResponse> ContactResponse(ContactRecord value) => await (Task<ContactResponse>)Invoke("ToContactResponseAsync", value, store, CancellationToken.None)!;

db.Contacts.Add(Contact("bob", "alice")); await db.SaveChangesAsync();
var oneWay = await ContactResponse(await db.Contacts.SingleAsync());
Check(oneWay.ProfilePhotoDataUrl is null && oneWay.Phone is null, "saving an alias unilaterally grants neither a contact-only photo nor a phone number");
Check((await Summary(alice, "bob")).ProfilePhotoDataUrl is null && (await Summary(alice, "bob")).Phone is null, "directory mapper agrees with unilateral contact privacy");
db.Contacts.Add(Contact("alice", "bob")); await db.SaveChangesAsync();
var mutual = await Summary(alice, "bob");
Check(mutual.ProfilePhotoDataUrl == alice.ProfilePhotoDataUrl && mutual.Phone == alice.Phone && mutual.IsMutualContact, "mutual contacts can see the owner's contact photo and phone");
db.Contacts.Remove(await db.Contacts.SingleAsync(row => row.OwnerUserId == "bob")); await db.SaveChangesAsync();
var ownerOnly = await Summary(alice, "bob");
Check(ownerOnly.ProfilePhotoDataUrl == alice.ProfilePhotoDataUrl && ownerOnly.Phone is null, "contact photo follows owner's agenda while phone still requires both agendas");
alice.PrivacySettings.ProfilePhotoVisibility = "nobody"; await db.SaveChangesAsync();
Check((await Summary(alice, "bob")).ProfilePhotoDataUrl is null, "nobody photo rule overrides mutual or one-sided contacts");
Check((await Summary(alice, "alice")).ProfilePhotoDataUrl == alice.ProfilePhotoDataUrl && (await Summary(alice, "alice")).Phone == alice.Phone, "self profile retains its private photo and phone");

IQueryable<UserAccount> Discover(string query) => (IQueryable<UserAccount>)Invoke("DirectoryCandidates", db.Users, "carol", query)!;
Check(!Discover("").Any(user => user.Id == "bob"), "ghost is absent from broad discovery even when explicitly saved as a contact");
Check(!Discover("bob Name").Any(user => user.Id == "bob") && !Discover("bo").Any(user => user.Id == "bob"), "ghost cannot be found by display name or alias prefix");
Check(Discover("@bob").Any(user => user.Id == "bob") && Discover("987654321").Any(user => user.Id == "bob"), "ghost remains reachable by exact alias or public account number");
bob.DisabledAt = now; await db.SaveChangesAsync();
Check(!Discover("@bob").Any(user => user.Id == "bob"), "an exact address cannot reveal a disabled account");
bob.DisabledAt = null; bob.Alias = "new-ghost-alias"; await db.SaveChangesAsync();
Check(Discover("bob").Any(user => user.Id == "bob"), "exact stable ID shared by a QR remains reachable after an alias change");
Check((await store.ContactsForUserAsync("alice")).Any(contact => contact.ContactUserId == "bob"), "ghost filtering preserves the explicit saved address book");

var request = Request("pending", "alice", "bob"); db.FriendRequests.Add(request); await db.SaveChangesAsync();
var hub = new CaptureHub();
await (Task)Invoke("NotifyFriendRequestChangedAsync", db, hub, request, "friend.requested", CancellationToken.None)!;
var toBob = (FriendRequestResponse)hub.Messages.Single(item => item.Group == "user:bob").Args[0]!;
var toAlice = (FriendRequestResponse)hub.Messages.Single(item => item.Group == "user:alice").Args[0]!;
Check(toBob.From.ProfilePhotoDataUrl is null && toBob.From.Phone is null, "request event sent to recipient excludes sender's self-only photo and phone");
Check(toAlice.To.ProfilePhotoDataUrl is null && toAlice.To.Phone is null, "request event sent to sender excludes recipient's self-only photo and phone");
Check(toAlice.From.ProfilePhotoDataUrl == alice.ProfilePhotoDataUrl && toBob.To.ProfilePhotoDataUrl == bob.ProfilePhotoDataUrl, "each account still receives its own self profile projection");
hub.Messages.Clear();
db.Contacts.RemoveRange(db.Contacts); await db.SaveChangesAsync();
await (Task)Invoke("NotifyProfileUpdatedAsync", db, hub, "alice", CancellationToken.None, new[] { "bob" })!;
var revocation = JsonSerializer.SerializeToElement(hub.Messages.Single(item => item.Group == "user:bob").Args[0], new JsonSerializerOptions(JsonSerializerDefaults.Web));
Check(revocation.GetProperty("userId").GetString() == "alice" && revocation.GetProperty("profilePhotoDataUrl").ValueKind == JsonValueKind.Null && revocation.GetProperty("phone").ValueKind == JsonValueKind.Null,
    "removing a relationship emits explicit authoritative nulls to the former viewer immediately");
hub.Messages.Clear();
db.FriendRequests.Add(Request("closed-carol", "carol", "alice", FriendRequestStatus.Rejected)); await db.SaveChangesAsync();
await (Task)Invoke("NotifyProfileUpdatedAsync", db, hub, "alice", CancellationToken.None, null)!;
Check(hub.Messages.Any(item => item.Group == "user:bob") && hub.Messages.Any(item => item.Group == "user:carol"),
    "profile revocations reach pending and historical request viewers even without contacts or conversations");

var duplicate = Request("duplicate", "bob", "alice", seconds: 1); var another = Request("other-pair", "alice", "carol", seconds: 2);
var historical = Request("accepted-history", "alice", "bob", FriendRequestStatus.Accepted, -10);
db.FriendRequests.AddRange(duplicate, another, historical); await db.SaveChangesAsync();
IQueryable<FriendRequestRecord> Pending(IQueryable<FriendRequestRecord> source, string viewer) => (IQueryable<FriendRequestRecord>)Invoke("PendingFriendRequestsForViewer", source, viewer)!;
Check(Pending(db.FriendRequests, "alice").Select(row => row.Id).ToHashSet().SetEquals(["pending", "other-pair"]), "pending queue contains one deterministic request per pair without closed history crowding it out");
Check(!Pending(db.FriendRequests, "carol").Any(row => row.Id == "pending"), "pending queue cannot include another account's requests");
var superseded = new[] { Request("old-pending", "alice", "bob", seconds: -30), Request("new-acceptance", "bob", "alice", FriendRequestStatus.Accepted, seconds: -10) }.AsQueryable();
Check(!Pending(superseded, "alice").Any(), "a legacy pending row is hidden after a later acceptance for the same pair");
var renewed = superseded.Append(Request("new-request", "alice", "bob", seconds: 10)).AsQueryable();
Check(Pending(renewed, "alice").Single().Id == "new-request", "a genuinely newer request after removing a contact remains actionable");
await (Task)Invoke("CloseDuplicateFriendRequestsAsync", db, request, now.AddMinutes(1), CancellationToken.None)!; await db.SaveChangesAsync();
Check(duplicate.Status == FriendRequestStatus.Cancelled && duplicate.RespondedAt is not null && request.Status == FriendRequestStatus.Pending && another.Status == FriendRequestStatus.Pending && historical.Status == FriendRequestStatus.Accepted,
    "duplicate cleanup closes only duplicate pending rows and preserves canonical, unrelated and historical data");
bool CanRespond(string actor, FriendRequestStatus next) => (bool)Invoke("CanRespondToFriendRequest", request, actor, next)!;
Check(CanRespond("bob", FriendRequestStatus.Accepted) && CanRespond("bob", FriendRequestStatus.Rejected) && !CanRespond("alice", FriendRequestStatus.Accepted), "only the intended receiver may accept or reject");
Check(CanRespond("alice", FriendRequestStatus.Cancelled) && !CanRespond("bob", FriendRequestStatus.Cancelled) && !CanRespond("carol", FriendRequestStatus.Accepted), "only sender may cancel; unrelated account cannot mutate a request");
request.Status = FriendRequestStatus.Cancelled;
Check(!(bool)Invoke("CanTransitionFriendRequest", request, FriendRequestStatus.Accepted)! && (bool)Invoke("CanTransitionFriendRequest", request, FriendRequestStatus.Cancelled)!, "a concurrent cancel cannot later become accepted while retrying the winning operation stays idempotent");
request.Status = FriendRequestStatus.Accepted;
Check(!(bool)Invoke("CanTransitionFriendRequest", request, FriendRequestStatus.Rejected)! && (bool)Invoke("CanTransitionFriendRequest", request, FriendRequestStatus.Accepted)!, "a concurrent accept cannot later become rejected or lose mutual contacts");
var lockAB = Invoke("RelationshipLockKey", "alice", "bob");
Check(Equals(lockAB, Invoke("RelationshipLockKey", "bob", "alice")) && !Equals(lockAB, Invoke("RelationshipLockKey", "alice", "carol")), "both directions and all contact/friend actions share one stable PostgreSQL transaction lock per pair");

alice.DisplayName = null;
var groupName = await (Task<string>)Invoke("DefaultGroupNameAsync", store, new[] { "alice" }, CancellationToken.None)!;
Check(groupName == alice.Alias && !groupName.Contains(alice.Phone!), "automatic group names never disclose a member phone as an alias fallback");
alice.IsPrivateAccount = true;
Check((await Summary(alice, "bob")).IsPrivateAccount && !((await Summary(bob, "alice")).IsPrivateAccount), "private-account marker follows persisted identity rather than ghost or contact state");

await using var sqlDb = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>().UseNpgsql("Host=localhost;Database=offline;Username=offline;Password=offline").Options);
var pendingSql = Pending(sqlDb.FriendRequests, "alice").Take(100).ToQueryString();
Check(pendingSql.Contains("NOT EXISTS", StringComparison.OrdinalIgnoreCase) && pendingSql.Contains("Pending", StringComparison.Ordinal), "PostgreSQL translates pair-wise pending deduplication and pagination without contacting a live database");
var directorySql = ((IQueryable<UserAccount>)Invoke("DirectoryCandidates", sqlDb.Users, "carol", "@bob")!).ToQueryString();
Check(directorySql.Contains("\"IsDiscoverable\"") && !directorySql.Contains("contacts", StringComparison.OrdinalIgnoreCase), "discovery SQL cannot use saved contacts to bypass ghost filtering");
Console.WriteLine($"{checks} social privacy and friendship checks passed (isolated fixtures; no live users).");

public sealed class CaptureHub : IHubContext<NivraHub>
{
    public List<(string Group, string Method, object?[] Args)> Messages { get; } = [];
    public IHubClients Clients { get; }
    public IGroupManager Groups => throw new NotSupportedException();
    public CaptureHub()
    {
        Clients = DispatchProxy.Create<IHubClients, HubClientsProxy>();
        ((HubClientsProxy)Clients).Group = group => new CaptureClient(group, Messages);
    }
}
public class HubClientsProxy : DispatchProxy
{
    public Func<string, IClientProxy> Group { get; set; } = null!;
    protected override object? Invoke(MethodInfo? target, object?[]? args) => target?.Name == "Group" ? Group((string)args![0]!) : throw new NotSupportedException(target?.Name);
}
public sealed class CaptureClient(string group, List<(string Group, string Method, object?[] Args)> messages) : IClientProxy
{
    public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
    { messages.Add((group, method, args)); return Task.CompletedTask; }
}
