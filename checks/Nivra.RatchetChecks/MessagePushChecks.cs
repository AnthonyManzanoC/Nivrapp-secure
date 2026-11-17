using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

public static class MessagePushChecks
{
    public static async Task Run(IServiceProvider appServices)
    {
        var passed=0;
        void Check(bool value,string label) { if(!value)throw new InvalidOperationException(label);passed++;Console.WriteLine("PASS "+label); }
        string connection;
        await using(var scope=appServices.CreateAsyncScope()) connection=scope.ServiceProvider.GetRequiredService<NivraDbContext>().Database.GetConnectionString()!;
        var transport=new FixturePushTransport();
        var services=new ServiceCollection();
        services.AddDbContext<NivraDbContext>(options=>options.UseNpgsql(connection));
        services.AddSingleton<IHttpClientFactory>(transport);
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddSingleton<IOptionsMonitor<NivraPushOptions>>(new FixtureOptions(new() {Enabled=true,Provider="Synthetic",WebPush=new() {Enabled=true}}));
        services.AddLogging(); services.AddSingleton<PushNotificationService>();
        await using var provider=services.BuildServiceProvider();
        var pushes=provider.GetRequiredService<PushNotificationService>();
        var scopes=provider.GetRequiredService<IServiceScopeFactory>();
        var now=DateTimeOffset.UtcNow;
        const string recipient="usr-push-recipient",sender="usr-push-sender",chatId="chat-push-lab",firstMessage="msg-push-first";
        async Task Mutate(Func<NivraDbContext,Task> action)
        {
            await using var scope=provider.CreateAsyncScope();var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            await action(db);await db.SaveChangesAsync();
        }
        string B64(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
        string Subscription(string id)
        {
            using var key=ECDsa.Create(ECCurve.NamedCurves.nistP256);var point=key.ExportParameters(false).Q;
            return JsonSerializer.Serialize(new {endpoint="https://push-fixture.invalid/"+id,keys=new {p256dh=B64([4,..point.X!,..point.Y!]),auth=B64(RandomNumberGenerator.GetBytes(16))}});
        }
        DeviceRecord Device(string id,string user,bool revoked=false)=>new() {Id=id,UserId=user,Name="Synthetic push destination",IsTrusted=true,CreatedAt=now,RevokedAt=revoked?now:null};
        MessageEnvelope Message(string id)=>new() {Id=id,ClientMessageId=id,ConversationId=chatId,SenderUserId=sender,SenderDeviceId="dev-push-sender",ServerReceivedAt=now,
            Recipients=[new() {UserId=sender,DeviceId="dev-push-sender",Ciphertext="opaque"},new() {UserId=recipient,DeviceId="dev-push-00",Ciphertext="opaque"}]};
        await Mutate(db=>
        {
            foreach(var id in new[]{recipient,sender}) db.Users.Add(new() {Id=id,Alias=id,PasswordHash=new("fixture",1,"fixture","fixture"),CreatedAt=now,UpdatedAt=now});
            db.Devices.Add(Device("dev-push-sender",sender));
            for(var index=0;index<11;index++)db.Devices.Add(Device($"dev-push-{index:00}",recipient,index==9));
            var chat=new ConversationRecord {Id=chatId,Type=ConversationType.Direct,CreatedByUserId=sender,CreatedAt=now,UpdatedAt=now};
            chat.Participants.Add(new() {UserId=sender,JoinedAt=now});chat.Participants.Add(new() {UserId=recipient,JoinedAt=now});db.Conversations.Add(chat);
            for(var index=0;index<11;index++)
            {
                var id=$"push-token-{index:00}";
                db.PushTokens.Add(new() {Id=id,UserId=recipient,DeviceId=$"dev-push-{index:00}",Provider="webpush",TokenHash=id,TokenCiphertext=pushes.ProtectToken(Subscription(id)),CreatedAt=now,RevokedAt=index==10?now:null});
            }
            db.PushTokens.Add(new() {Id="push-token-foreign",UserId="usr-lab-carol",DeviceId="dev-lab-carol",Provider="webpush",TokenHash="push-token-foreign",TokenCiphertext=pushes.ProtectToken(Subscription("foreign")),CreatedAt=now});
            db.PushTokens.Add(new() {Id="push-token-mismatched",UserId=recipient,DeviceId="dev-lab-carol",Provider="webpush",TokenHash="push-token-mismatched",TokenCiphertext=pushes.ProtectToken(Subscription("mismatched")),CreatedAt=now});
            var message=Message(firstMessage);db.Messages.Add(message);MessagePushOutbox.Enqueue(db,message);
            return Task.CompletedTask;
        });
        async Task<MessagePushOutboxItem> ReadJob(string id)
        {
            await using var scope=provider.CreateAsyncScope();return await scope.ServiceProvider.GetRequiredService<NivraDbContext>().MessagePushOutbox.AsNoTracking().SingleAsync(row=>row.MessageId==id);
        }
        var first=await ReadJob(firstMessage);
        Check(first.RecipientUserId==recipient,"persisting a message enqueues one opaque notification job and excludes its sender");
        // Eight transports never answer. A short outer deadline models the real
        // worker budget without waiting for external services or using the network.
        for(var attempt=0;attempt<3;attempt++)
        {
            first=await ReadJob(firstMessage);var completed=MessagePushOutbox.CompletedDestinations(first);
            async Task Acknowledge(string tokenId)
            {
                completed.Add(tokenId);
                await Mutate(async db=>{(await db.MessagePushOutbox.SingleAsync(row=>row.MessageId==firstMessage)).CompletedPushTokenIdsJson=JsonSerializer.Serialize(completed);});
            }
            using var deadline=new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
            try { await pushes.DispatchMessageAsync(recipient,chatId,firstMessage,sender,deadline.Token,completed,Acknowledge,attempt*4); }
            catch(OperationCanceledException) when(deadline.IsCancellationRequested) { }
        }
        first=await ReadJob(firstMessage);
        Check(transport.Succeeded.GetValueOrDefault("push-token-08")==1 && MessagePushOutbox.CompletedDestinations(first).Contains("push-token-08"),
            "a ninth healthy destination is acknowledged durably despite eight permanently stalled earlier destinations");
        Check(!transport.Attempts.ContainsKey("push-token-09")&&!transport.Attempts.ContainsKey("push-token-10")&&!transport.Attempts.ContainsKey("foreign")&&!transport.Attempts.ContainsKey("mismatched"),
            "push routing excludes revoked devices, revoked tokens, other accounts and mismatched device ownership");
        transport.Stall=false;
        var worker=new MessagePushOutboxWorker(scopes,TimeProvider.System,NullLogger<MessagePushOutboxWorker>.Instance);
        await worker.RunOnceAsync(CancellationToken.None);
        first=await ReadJob(firstMessage);
        Check(first.CompletedAt is not null && MessagePushOutbox.CompletedDestinations(first).Count==9 && transport.Succeeded["push-token-08"]==1,
            "a replacement worker resumes persisted per-destination progress without notifying an already acknowledged device again");
        transport.Attempts.Clear();transport.Succeeded.Clear();
        const string racingMessage="msg-push-racing";
        await Mutate(db=>{var message=Message(racingMessage);db.Messages.Add(message);MessagePushOutbox.Enqueue(db,message);return Task.CompletedTask;});
        var otherWorker=new MessagePushOutboxWorker(scopes,TimeProvider.System,NullLogger<MessagePushOutboxWorker>.Instance);
        await Task.WhenAll(worker.RunOnceAsync(CancellationToken.None),otherWorker.RunOnceAsync(CancellationToken.None));
        var raced=await ReadJob(racingMessage);
        Check(raced.CompletedAt is not null&&transport.Succeeded.Count==9&&transport.Succeeded.Values.All(count=>count==1),
            "two PostgreSQL workers atomically lease a message job and notify each active destination once");
        transport.Attempts.Clear();transport.Succeeded.Clear();
        const string removedMessage="msg-push-removed";
        await Mutate(async db=>
        {
            var message=Message(removedMessage);db.Messages.Add(message);MessagePushOutbox.Enqueue(db,message);
            (await db.Conversations.SingleAsync(row=>row.Id==chatId)).Participants.Single(row=>row.UserId==recipient).RemovedAt=now;
        });
        await worker.RunOnceAsync(CancellationToken.None);
        Check((await ReadJob(removedMessage)).CompletedAt is not null&&transport.Attempts.Count==0,
            "removed conversation membership suppresses a previously queued notification before transport delivery");
        transport.Ttls.Clear();
        await pushes.DispatchMessageAsync(recipient,chatId,"msg-push-short-ttl",sender,CancellationToken.None,expiresAt:DateTimeOffset.UtcNow.AddSeconds(1));
        Check(transport.Ttls.Count==9&&transport.Ttls.All(ttl=>ttl is >=0 and <=1),
            "provider queue retention is bounded by the message privacy expiration instead of a day-long default");
        Console.WriteLine($"PASS {passed} durable multi-device push and privacy checks");
    }

    private sealed class FixtureOptions(NivraPushOptions value):IOptionsMonitor<NivraPushOptions>
    {
        public NivraPushOptions CurrentValue=>value;
        public NivraPushOptions Get(string? name)=>value;
        public IDisposable? OnChange(Action<NivraPushOptions,string?> listener)=>null;
    }
    private sealed class FixturePushTransport:HttpMessageHandler,IHttpClientFactory
    {
        public bool Stall=true;
        public ConcurrentDictionary<string,int> Attempts {get;}=new();
        public ConcurrentDictionary<string,int> Succeeded {get;}=new();
        public ConcurrentBag<int> Ttls {get;}=new();
        public HttpClient CreateClient(string name)=>new(this,disposeHandler:false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            if(request.RequestUri?.Host!="push-fixture.invalid")throw new InvalidOperationException("A push fixture attempted real network access.");
            var id=request.RequestUri.AbsolutePath.Trim('/');Attempts.AddOrUpdate(id,1,(_,count)=>count+1);
            Ttls.Add(int.Parse(request.Headers.GetValues("TTL").Single(),System.Globalization.CultureInfo.InvariantCulture));
            if(Stall&&id!="push-token-08")await Task.Delay(Timeout.Infinite,ct);
            Succeeded.AddOrUpdate(id,1,(_,count)=>count+1);
            return new(HttpStatusCode.Created);
        }
    }
}
