using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Realtime;
using Nivra.Api.Services;

var checks = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException(description);
    Console.WriteLine($"PASS {description}"); checks++;
}
var now = DateTimeOffset.UtcNow;
var scratch = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "nivra-upload-checks-" + Guid.NewGuid().ToString("N")));
Directory.CreateDirectory(scratch);
var environment = new TestEnvironment { ContentRootPath = scratch };
var fixture = new S3Fixture();
var factory = new FixtureHttpClientFactory(fixture);
var options = new NivraStorageOptions
{
    Provider = "SupabaseS3", Endpoint = "https://storage.example.test/storage/v1/s3", Bucket = "encrypted",
    Region = "us-east-2", AccessKeyId = "fixture-access", SecretAccessKey = "fixture-secret", LocalPath = "local"
};
var storage = new EncryptedFileStorage(environment, Options.Create(options), NullLogger<EncryptedFileStorage>.Instance, factory);
var payload = RandomNumberGenerator.GetBytes(1024 * 1024 + 17);
FileObject NewFile(string id = "file-test", long? size = null) => new()
{
    Id = id, OwnerUserId = "alice", StorageKey = "users/alice/" + id + ".enc",
    EncryptedSize = size ?? payload.LongLength, AllowedUserIds = ["alice", "bob"], State = FileState.Reserved,
    CreatedAt = now, ExpiresAt = now.AddHours(24)
};

try
{
    // Exercise the real AWS serialization/signing pipeline, not a mocked PutObject method.
    var legacyRejected = false;
    using (var legacy = new AmazonS3Client(new BasicAWSCredentials("fixture-access", "fixture-secret"), new AmazonS3Config
    {
        ServiceURL = options.Endpoint, ForcePathStyle = true, AuthenticationRegion = options.Region, HttpClientFactory = factory, MaxErrorRetry = 0
    }))
    {
        var request = new PutObjectRequest { BucketName = options.Bucket, Key = "legacy.enc", InputStream = new NonSeekableStream(payload), AutoCloseStream = false };
        request.Headers.ContentLength = payload.LongLength;
        try { await legacy.PutObjectAsync(request); }
        catch (Exception error) when (error is AmazonClientException or AmazonS3Exception or InvalidOperationException or NotSupportedException)
        { legacyRejected = true; }
    }
    Check(legacyRejected, "legacy non-seek HTTP body fails the strict S3-compatible protocol fixture");
    fixture.Reset();
    var file = NewFile();
    using var body = new NonSeekableStream(payload);
    var written = await storage.SaveAsync(file, body, payload.LongLength, CancellationToken.None);
    var expectedHash = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
    Check(written == payload.LongLength && fixture.LastPayload!.SequenceEqual(payload), "real AWS SDK uploads every encrypted byte from a non-seekable HTTP source");
    Check(fixture.LastPayloadHash == expectedHash && fixture.LastAuthorization.StartsWith("AWS4-HMAC-SHA256 Credential=fixture-access/"), "Supabase upload preserves SigV4 SHA-256 payload signing");
    Check(!fixture.LastChunked && !fixture.LastOptionalChecksum && fixture.LastContentLength == payload.LongLength, "Supabase upload uses plain content length without unsupported checksum/chunk trailers");
    Check(fixture.LastPath.EndsWith("/encrypted/users/alice/file-test.enc", StringComparison.Ordinal) && file.ClientSha256 == expectedHash, "path-style object key and persisted ciphertext digest match the uploaded bytes");
    Check(body.CanRead, "upload never closes the incoming request body");

    async Task InvalidBody(byte[] bytes, long declaredLength, string? hash, string expectedCode)
    {
        fixture.Reset(); var candidate = NewFile(size: declaredLength); candidate.ClientSha256 = hash;
        var rejected = false;
        try { await storage.SaveAsync(candidate, new NonSeekableStream(bytes), declaredLength, CancellationToken.None); }
        catch (EncryptedUploadException error) { rejected = error.Code == expectedCode; }
        Check(rejected && fixture.Calls == 0, $"{expectedCode} rejects malformed ciphertext before contacting shared storage");
    }
    await InvalidBody(payload[..10], payload.LongLength, null, "upload_size_mismatch");
    await InvalidBody(payload, 10, null, "upload_size_mismatch");
    await InvalidBody(payload, payload.LongLength, new string('0', 64), "upload_integrity_mismatch");
    await InvalidBody([], EncryptedDownloadPolicy.MaxEncryptedBytes + 1, null, "invalid_upload");

    var localOptions = new NivraStorageOptions { LocalPath = "local" };
    var local = new EncryptedFileStorage(environment, Options.Create(localOptions), NullLogger<EncryptedFileStorage>.Instance);
    var localFile = NewFile("local-file");
    await local.SaveAsync(localFile, new NonSeekableStream(payload), payload.LongLength, CancellationToken.None);
    await using (var downloaded = await local.OpenReadAsync(localFile, CancellationToken.None))
    {
        using var copy = new MemoryStream(); await downloaded.CopyToAsync(copy);
        Check(copy.ToArray().SequenceEqual(payload), "local Windows storage commits a closed validated temporary file and reads it intact");
    }
    Check(!Directory.EnumerateFiles(Path.Combine(scratch, "local"), "*.tmp").Any(), "local successful and failed uploads leave no temporary ciphertext files");
    var cancelled = new CancellationToken(true); var cancelledRejected = false;
    try { await local.SaveAsync(NewFile("cancelled"), new NonSeekableStream(payload), payload.LongLength, cancelled); }
    catch (OperationCanceledException) { cancelledRejected = true; }
    Check(cancelledRejected && !await local.ExistsAsync(NewFile("cancelled"), CancellationToken.None) && !Directory.EnumerateFiles(Path.Combine(scratch, "local"), "*.tmp").Any(), "cancelled upload cleans its temporary file and never commits a partial object");

    var store = DispatchProxy.Create<INivraStore, StoreFixture>();
    var proxy = (StoreFixture)(object)store;
    var uploadMethod = typeof(EndpointExtensions).GetMethod("UploadEncryptedFileAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
    async Task<IResult> Upload(FileObject? candidate, string? user = "alice", long? length = null)
    {
        proxy.File = candidate; proxy.Saves = 0; fixture.Reset();
        var http = new DefaultHttpContext { RequestServices = services };
        if (user is not null) http.Items["__nivra_current_user"] = new CurrentUser(user, "fixture-device", "fixture-session");
        http.Request.ContentLength = length ?? payload.LongLength;
        http.Request.Body = new NonSeekableStream(payload);
        return await (Task<IResult>)uploadMethod.Invoke(null, [candidate?.Id ?? "missing", http, store, storage, TimeProvider.System, CancellationToken.None])!;
    }
    int Status(IResult result) => ((IStatusCodeHttpResult)result).StatusCode ?? 200;
    Check(Status(await Upload(NewFile(), null)) == 401 && fixture.Calls == 0, "unauthenticated upload cannot read or modify shared storage");
    Check(Status(await Upload(NewFile(), "mallory")) == 404 && fixture.Calls == 0, "outsider upload cannot replace another user's ciphertext");
    var expired = NewFile(); expired.ExpiresAt = now.AddSeconds(-1);
    Check(Status(await Upload(expired)) == 404 && fixture.Calls == 0, "expired reservation cannot be revived by uploading");
    var deleted = NewFile(); deleted.State = FileState.Deleted;
    Check(Status(await Upload(deleted)) == 404 && fixture.Calls == 0, "deleted file cannot be recreated by uploading");
    Check(Status(await Upload(NewFile(), length: EncryptedDownloadPolicy.MaxEncryptedBytes + 1)) == 413 && fixture.Calls == 0, "HTTP handler rejects oversized bodies before storage work");
    Check(Status(await Upload(NewFile(), length: 10)) == 400 && fixture.Calls == 0, "HTTP handler checks declared length against its reservation");
    var uploaded = NewFile(); uploaded.State = FileState.Uploaded; uploaded.ClientSha256 = expectedHash;
    Check(Status(await Upload(uploaded)) == 200 && fixture.Calls == 0 && proxy.Saves == 0 && uploaded.ClientSha256 == expectedHash, "lost-response retry returns the committed record without overwriting published media");
    fixture.FailureStatus = HttpStatusCode.Forbidden;
    var storageFailure = await Upload(NewFile());
    Check(Status(storageFailure) == 502 && ((ApiError)((IValueHttpResult)storageFailure).Value!).Code == "storage_upload_failed" && proxy.File!.State == FileState.Reserved && proxy.Saves == 0, "provider credential/bucket denial returns a safe storage code and keeps the reservation uncommitted");
    fixture.FailureStatus = null;
    var completed = NewFile();
    Check(Status(await Upload(completed)) == 200 && proxy.Saves == 1 && completed.State == FileState.Uploaded && completed.ClientSha256 == expectedHash, "HTTP upload marks uploaded only after the complete encrypted object is saved");

    await using var db = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>().UseInMemoryDatabase("story-file-acl-" + Guid.NewGuid()).Options);
    var aclMethod = typeof(EndpointExtensions).GetMethod("UserCanAccessFileAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    async Task<bool> CanRead(FileObject candidate, string user = "bob") =>
        await (Task<bool>)aclMethod.Invoke(null, [user, candidate, store, db, now, CancellationToken.None])!;
    var media = NewFile("story-media"); media.State = FileState.Uploaded;
    var story = new StoryRecord
    {
        Id = "story-one", OwnerUserId = "alice", EncryptedPayload = "fixture-ciphertext", MediaFileObjectId = media.Id,
        Visibility = StoryVisibility.SelectedUsers, AllowedUserIds = ["bob"], CreatedAt = now, ExpiresAt = now.AddHours(1), ViewOnce = true
    };
    db.Stories.Add(story); await db.SaveChangesAsync();
    Check(await CanRead(media), "active story permits its encrypted recipient before first viewing");
    story.ViewedByUserIds.Add("bob"); await db.SaveChangesAsync();
    Check(!await CanRead(media), "generic file URL cannot bypass a consumed read-once story using its old file ACL");
    story.ViewOnce = false; story.DeletedAt = now; await db.SaveChangesAsync();
    Check(!await CanRead(media), "generic file URL cannot bypass deleted story revocation");
    story.DeletedAt = null; story.ExpiresAt = now.AddSeconds(-1); await db.SaveChangesAsync();
    Check(!await CanRead(media), "generic file URL cannot bypass expired story revocation before cleanup");
    story.ExpiresAt = now.AddHours(1); story.TargetType = "group"; story.TargetId = "group-test";
    var group = new ConversationRecord { Id = story.TargetId, Type = ConversationType.Group, CreatedByUserId = "alice", CreatedAt = now };
    group.Participants.Add(new ConversationParticipant { UserId = "bob", JoinedAt = now, RemovedAt = now });
    db.Conversations.Add(group); await db.SaveChangesAsync();
    Check(!await CanRead(media), "former group member cannot download story ciphertext with an old recipient ACL");
    group.Participants[0].RemovedAt = null; await db.SaveChangesAsync();
    Check(await CanRead(media), "current group member retains authorized story media access");
    Check(await CanRead(NewFile("ordinary-message")), "ordinary encrypted message attachments preserve recipient ACL access");
    media.ExpiresAt = now;
    Check(!await CanRead(media, "alice"), "file expiry applies even to owner access before asynchronous cleanup");

    var attach = NewFile();
    Check(!StoryMediaPolicy.CanAttach(attach, "alice", now), "failed reserved upload cannot be published as story media");
    attach.State = FileState.Uploaded;
    Check(StoryMediaPolicy.CanAttach(attach, "alice", now) && !StoryMediaPolicy.CanAttach(attach, "mallory", now), "story creation accepts only the owner's uploaded media");
    attach.VaultRoomId = "vault-private";
    Check(!StoryMediaPolicy.CanAttach(attach, "alice", now), "private vault media cannot escape through story publication");
    Check(StoryMediaPolicy.Deadline(now.AddHours(24), now.AddHours(1)) == now.AddHours(1), "story lifetime cannot outlive its media file");
    story.ViewOnce = true;
    Check(!StoryMediaPolicy.CanRepost(story, true), "read-once story cannot be converted into a reusable repost");
    story.ViewOnce = false;
    Check(StoryMediaPolicy.CanRepost(story, true) && !StoryMediaPolicy.CanRepost(story, false), "repost still requires both story and author permission");
    Check(!StoryMediaPolicy.ValidPayload(new string('x', StoryMediaPolicy.MaxEncryptedPayloadChars + 1)) &&
        !StoryMediaPolicy.ValidPayload("fixture-ciphertext", new string('x', StoryMediaPolicy.MaxCaptionChars + 1)), "oversized encrypted story payload and caption cannot enter persistent storage");

    db.Users.Add(new UserAccount { Id = "alice", Alias = "alice", NivraNumber = "123456789", PasswordHash = new PasswordHash(), CreatedAt = now });
    await db.SaveChangesAsync();
    var savePublication = typeof(EndpointExtensions).GetMethod("SaveStoryPublicationAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    var toResponse = typeof(EndpointExtensions).GetMethod("ToStoryResponseAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    var hub = new ThrowingHubContext();
    var committedStory = new StoryRecord
    {
        Id = "story-persisted-before-notification", OwnerUserId = "alice", Visibility = StoryVisibility.PublicWorld,
        EncryptedPayload = "fixture-ciphertext", CreatedAt = now, ExpiresAt = now.AddHours(24)
    };
    var publicationResponse = await (Task<StoryResponse>)toResponse.Invoke(null, [committedStory, "alice", db, CancellationToken.None])!;
    var notificationContext = new DefaultHttpContext { RequestServices = services };
    Func<CancellationToken, Task> notify = token => hub.Clients.All.SendAsync("story.worldCreated", publicationResponse, token);
    var publication = await (Task<IResult>)savePublication.Invoke(null, [committedStory, db, publicationResponse, notificationContext, notify, CancellationToken.None])!;
    Check(Status(publication) == 201 && await db.Stories.CountAsync(candidate => candidate.Id == committedStory.Id) == 1 && hub.Calls == 1,
        "Redis hub failure after commit still returns Created with exactly one persisted story");
    Check(((StoryResponse)((IValueHttpResult)publication).Value!).Id == committedStory.Id,
        "committed publication keeps its original response when notification transport fails");

    for (var index = 0; index < 400; index++)
        db.Stories.Add(new StoryRecord { Id = "unrelated-" + index, OwnerUserId = "outside", EncryptedPayload = "fixture-ciphertext",
            Visibility = StoryVisibility.SelectedUsers, AllowedUserIds = ["mallory"], CreatedAt = now.AddSeconds(index), ExpiresAt = now.AddHours(1) });
    var oldVisible = new StoryRecord { Id = "older-visible-story", OwnerUserId = "alice", EncryptedPayload = "fixture-ciphertext",
        Visibility = StoryVisibility.SelectedUsers, AllowedUserIds = ["bob"], CreatedAt = now.AddMinutes(-20), ExpiresAt = now.AddHours(1) };
    db.Stories.Add(oldVisible); await db.SaveChangesAsync();
    var scope = await StoryVisibilityQuery.ReadScopeAsync(db, "bob", CancellationToken.None);
    var visibleFeed = await StoryVisibilityQuery.Visible(db, scope, now)
        .Where(candidate => candidate.Visibility != StoryVisibility.PublicWorld || candidate.OwnerUserId == "bob")
        .OrderByDescending(candidate => candidate.CreatedAt).Take(160).ToListAsync();
    Check(visibleFeed.Any(candidate => candidate.Id == oldVisible.Id) && visibleFeed.All(candidate => !candidate.Id.StartsWith("unrelated-", StringComparison.Ordinal)),
        "older authorized story survives 400 newer unrelated stories because visibility is applied before the feed limit");
    group.Participants[0].RemovedAt = now; await db.SaveChangesAsync();
    var revokedScope = await StoryVisibilityQuery.ReadScopeAsync(db, "bob", CancellationToken.None);
    Check(!await StoryVisibilityQuery.Visible(db, revokedScope, now).AnyAsync(candidate => candidate.Id == story.Id),
        "batch feed policy excludes a removed group member before pagination");
    await using var sqlDb = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>()
        .UseNpgsql("Host=127.0.0.1;Database=fixture;Username=fixture;Password=fixture").Options);
    var sql = StoryVisibilityQuery.Visible(sqlDb, scope, now).OrderByDescending(candidate => candidate.CreatedAt).Take(160).ToQueryString();
    Check(sql.Contains("allowed_user_ids", StringComparison.Ordinal) && sql.Contains("viewed_by_user_ids", StringComparison.Ordinal) &&
        sql.Contains(" ? ", StringComparison.Ordinal) && sql.IndexOf("WHERE", StringComparison.Ordinal) < sql.IndexOf("LIMIT", StringComparison.Ordinal),
        "production Npgsql translates JSON membership, consumed-state and visibility into SQL before LIMIT without opening a database connection");

    db.Users.Add(new UserAccount { Id = "bob", Alias = "bob", NivraNumber = "123456788", PasswordHash = new PasswordHash(), CreatedAt = now });
    var alice = await db.Users.SingleAsync(user => user.Id == "alice");
    alice.Phone = "+10000000000"; alice.ProfilePhotoDataUrl = "data:image/png;base64,fixture";
    alice.PrivacySettings.ProfilePhotoVisibility = "contacts";
    db.Contacts.Add(new ContactRecord { Id = "alice-saved-bob", OwnerUserId = "alice", ContactUserId = "bob", CreatedAt = now });
    var contactStory = new StoryRecord { Id = "contact-story", OwnerUserId = "alice", EncryptedPayload = "fixture-ciphertext",
        Visibility = StoryVisibility.Contacts, CreatedAt = now, ExpiresAt = now.AddHours(1) };
    var mutualStory = new StoryRecord { Id = "mutual-story", OwnerUserId = "alice", EncryptedPayload = "fixture-ciphertext",
        Visibility = StoryVisibility.MutualContacts, CreatedAt = now, ExpiresAt = now.AddHours(1) };
    db.Stories.AddRange(contactStory, mutualStory); await db.SaveChangesAsync();
    var oneWayScope = await StoryVisibilityQuery.ReadScopeAsync(db, "bob", CancellationToken.None);
    Check(await StoryVisibilityQuery.Visible(db, oneWayScope, now).AnyAsync(candidate => candidate.Id == contactStory.Id) &&
        !await StoryVisibilityQuery.Visible(db, oneWayScope, now).AnyAsync(candidate => candidate.Id == mutualStory.Id),
        "batched visibility preserves owner-to-viewer contacts and requires both directions for mutual contacts");

    oldVisible.ViewEvents.Add(new StoryViewEvent { UserId = "bob", ViewedAt = now });
    oldVisible.ViewedByUserIds.Add("bob");
    oldVisible.Reactions.Add(new StoryReactionRecord { Id = "fixture-reaction", UserId = "bob", Emoji = "👍", ReactedAt = now });
    oldVisible.Comments.Add(new StoryCommentRecord { Id = "fixture-comment", UserId = "bob", MessageId = "fixture-message", CommentedAt = now });
    await db.SaveChangesAsync();
    var batchResponseMethod = typeof(EndpointExtensions).GetMethod("ToStoryResponsesAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    async Task<StoryResponse> BatchResponse(string viewer) => (await (Task<List<StoryResponse>>)batchResponseMethod.Invoke(null,
        [new List<StoryRecord> { oldVisible }, viewer, db, CancellationToken.None])!).Single();
    var bobBatch = await BatchResponse("bob");
    var bobSingle = await (Task<StoryResponse>)toResponse.Invoke(null, [oldVisible, "bob", db, CancellationToken.None])!;
    Check(JsonSerializer.Serialize(bobBatch) == JsonSerializer.Serialize(bobSingle) && bobBatch.Views.Count == 0 && bobBatch.Reactions.Count == 0 && bobBatch.Comments.Count == 0,
        "batched feed response matches existing viewer behavior and exposes no private viewer/reaction/comment statistics");
    Check(bobBatch.Owner.Phone is null && bobBatch.Owner.ProfilePhotoDataUrl == alice.ProfilePhotoDataUrl,
        "batch summary preserves independent phone and contact-photo privacy rules");
    var aliceBatch = await BatchResponse("alice");
    var aliceSingle = await (Task<StoryResponse>)toResponse.Invoke(null, [oldVisible, "alice", db, CancellationToken.None])!;
    Check(JsonSerializer.Serialize(aliceBatch) == JsonSerializer.Serialize(aliceSingle) && aliceBatch.Views.Count == 1 && aliceBatch.Reactions.Count == 1 && aliceBatch.Comments.Count == 1,
        "batched owner feed preserves view timestamps, reactions, comments and all existing summary fields");
    oldVisible.ViewOnce = true; await db.SaveChangesAsync();
    Check(!await StoryVisibilityQuery.Visible(db, oneWayScope, now).AnyAsync(candidate => candidate.Id == oldVisible.Id),
        "consumed read-once story is excluded by the batched SQL policy before pagination");
    Console.WriteLine($"Completed {checks} story/upload checks (fixture credentials only, no production data).");
}
finally
{
    // The unique test directory contains only files generated above; no external paths are deleted.
    var localDir = Path.Combine(scratch, "local");
    if (Directory.Exists(localDir)) { foreach (var path in Directory.EnumerateFiles(localDir)) File.Delete(path); Directory.Delete(localDir); }
    Directory.Delete(scratch);
}

sealed class NonSeekableStream(byte[] bytes) : Stream
{
    private readonly MemoryStream inner = new(bytes);
    public override bool CanRead => inner.CanRead; public override bool CanSeek => false; public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => inner.ReadAsync(buffer, token);
    public override void Flush() => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
}
sealed class FixtureHttpClientFactory(S3Fixture handler) : Amazon.Runtime.HttpClientFactory
{
    private readonly HttpClient client = new(handler);
    public override HttpClient CreateHttpClient(IClientConfig config) => client;
    public override bool UseSDKHttpClientCaching(IClientConfig config) => false;
    public override bool DisposeHttpClientsAfterUse(IClientConfig config) => false;
}
sealed class S3Fixture : HttpMessageHandler
{
    public int Calls; public byte[]? LastPayload; public string LastAuthorization = ""; public string LastPayloadHash = "";
    public string LastPath = ""; public bool LastChunked; public bool LastOptionalChecksum; public long? LastContentLength;
    public HttpStatusCode? FailureStatus;
    public void Reset() { Calls = 0; LastPayload = null; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        Calls++; LastPayload = await request.Content!.ReadAsByteArrayAsync(token); LastPath = request.RequestUri!.AbsolutePath;
        LastAuthorization = request.Headers.TryGetValues("Authorization", out var auth) ? auth.First() : "";
        LastPayloadHash = request.Headers.TryGetValues("x-amz-content-sha256", out var hash) ? hash.First() : "";
        LastContentLength = request.Content.Headers.ContentLength;
        LastChunked = request.Headers.TransferEncodingChunked == true || request.Content.Headers.ContentEncoding.Contains("aws-chunked") || LastPayloadHash.StartsWith("STREAMING", StringComparison.Ordinal);
        LastOptionalChecksum = request.Headers.Any(header => header.Key.StartsWith("x-amz-checksum-", StringComparison.OrdinalIgnoreCase) || header.Key is "x-amz-trailer" or "x-amz-sdk-checksum-algorithm") || request.Content.Headers.Contains("Content-MD5");
        var status = FailureStatus ?? (LastChunked || LastOptionalChecksum ? HttpStatusCode.NotImplemented : HttpStatusCode.OK);
        var response = new HttpResponseMessage(status);
        if (status == HttpStatusCode.OK) response.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue("\"fixture-etag\"");
        else response.Content = new StringContent("<Error><Code>AccessDenied</Code><Message>fixture-provider-response</Message></Error>", Encoding.UTF8, "application/xml");
        return response;
    }
}
public class StoreFixture : DispatchProxy
{
    public FileObject? File; public int Saves;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method?.Name switch
    {
        "GetFileAsync" => Task.FromResult(File),
        "SaveChangesAsync" => Save(),
        "UserCanAccessFile" => ((FileObject)args![1]!).OwnerUserId == (string)args[0]! || ((FileObject)args[1]!).AllowedUserIds.Contains((string)args[0]!),
        _ => throw new NotSupportedException(method?.Name)
    };
    private Task<int> Save() { Saves++; return Task.FromResult(1); }
}
sealed class TestEnvironment : IWebHostEnvironment
{
    public string ApplicationName { get; set; } = "fixture"; public string EnvironmentName { get; set; } = "Development";
    public string ContentRootPath { get; set; } = ""; public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    public string WebRootPath { get; set; } = ""; public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
}
sealed class ThrowingHubContext : IHubContext<NivraHub>
{
    private readonly ThrowingClient client = new();
    public int Calls => client.Calls;
    public IHubClients Clients { get; }
    public IGroupManager Groups => throw new NotSupportedException();
    public ThrowingHubContext()
    {
        Clients = DispatchProxy.Create<IHubClients, HubClientsFixture>();
        ((HubClientsFixture)(object)Clients).Client = client;
    }
    private sealed class ThrowingClient : IClientProxy
    {
        public int Calls;
        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
        { Calls++; return Task.FromException(new IOException("fixture realtime transport unavailable")); }
    }
}
public class HubClientsFixture : DispatchProxy
{
    public IClientProxy Client = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Client;
}
