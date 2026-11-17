using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

public static class AccountHistorySyncChecks
{
    public static async Task Run(WebApplication app,Dictionary<string,string> existingTokens)
    {
        const string userId="usr-history-fixture",chatId="con-history-fixture";
        int checks=0;void Check(bool valid,string label){if(!valid)throw new InvalidOperationException(label);checks++;Console.WriteLine("PASS account history "+label);}
        using var root=ECDsa.Create(ECCurve.NamedCurves.nistP256);var q=root.ExportParameters(false).Q;
        string Coordinate(byte[] value)=>Convert.ToBase64String(value).TrimEnd('=').Replace('+','-').Replace('/','_');
        var rootKey=Coordinate(q.X!)+":"+Coordinate(q.Y!);
        var tokens=new Dictionary<string,string>();
        var now=DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        await using(var scope=app.Services.CreateAsyncScope()){
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            db.Users.Add(new UserAccount{Id=userId,Alias="history-fixture",PasswordHash=new("fixture",1,"fixture","fixture"),CreatedAt=now,UpdatedAt=now});
            db.AccountIdentities.Add(new AccountIdentityRecord{UserId=userId,PublicJson=JsonSerializer.Serialize(new AccountRootPublic(1,rootKey,"history-apk-1",Convert.ToBase64String(new byte[64]),rootKey,"fixture"),AccountIdentityPolicy.Json),PasswordBackup="opaque",RecoveryBackup="opaque",CreatedAt=now});
            await db.SaveChangesAsync();
            var conversation=new ConversationRecord{Id=chatId,CreatedByUserId="usr-lab-alice",Type=ConversationType.Direct,CreatedAt=now,UpdatedAt=now};
            conversation.Participants.Add(new ConversationParticipant{UserId=userId,JoinedAt=now});conversation.Participants.Add(new ConversationParticipant{UserId="usr-lab-alice",JoinedAt=now});
            db.Conversations.Add(conversation);
            foreach(var name in new[]{"valid","oneview","expired","deleted"})db.Messages.Add(new MessageEnvelope{
                Id="msg-history-"+name,ClientMessageId="client-history-"+name,ConversationId=chatId,SenderUserId="usr-lab-alice",SenderDeviceId="dev-lab-alice",ServerReceivedAt=now,
                DeleteAfterRead=name=="oneview",ExpiresAt=name=="expired"?now.AddSeconds(-1):null,
                Recipients=[new RecipientCiphertext{UserId=userId,DeviceId="history-apk-1",Ciphertext="opaque encrypted live transport"}],
                Receipts=name=="deleted"?[new DeliveryReceipt{UserId=userId,DeviceId="history-apk-1",DeletedAt=now}]:[]});
            await db.SaveChangesAsync();
        }
        async Task Enroll(string id){await using var scope=app.Services.CreateAsyncScope();var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var device=new DeviceRecord{Id=id,UserId=userId,Name="Synthetic "+id,IsTrusted=true,CreatedAt=DateTimeOffset.UtcNow};db.Devices.Add(device);await db.SaveChangesAsync();
            var pair=await scope.ServiceProvider.GetRequiredService<TokenService>().CreateSessionAsync(scope.ServiceProvider.GetRequiredService<INivraStore>(),await db.Users.SingleAsync(row=>row.Id==userId),device,null,null);tokens[id]=pair.AccessToken;}
        foreach(var id in new[]{"history-apk-1","history-apk-2","history-web","history-exe"})await Enroll(id);
        using var client=new HttpClient{BaseAddress=new Uri(app.Urls.Single())};
        async Task<HttpResponseMessage> Request(string? token,HttpMethod method,string path,object? body=null){using var request=new HttpRequestMessage(method,path);if(token is not null)request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);if(body is not null)request.Content=JsonContent.Create(body);return await client.SendAsync(request);}
        AccountHistoryEnvelope Row(string name){var value=new AccountHistoryEnvelope(1,rootKey,"msg-history-"+name,"client-history-"+name,chatId,"usr-lab-alice","dev-lab-alice",now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),Convert.ToBase64String(RandomNumberGenerator.GetBytes(12)),Convert.ToBase64String(RandomNumberGenerator.GetBytes(64)),"");return Sign(value);}
        AccountHistoryEnvelope Sign(AccountHistoryEnvelope row)=>row with{Signature=Convert.ToBase64String(root.SignData(EndpointExtensions.AccountHistoryStatement(userId,row),HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation))};
        var valid=Row("valid");
        using(var response=await Request(null,HttpMethod.Get,"/account/history-sync"))Check(response.StatusCode==HttpStatusCode.Unauthorized,"anonymous archive read denied");
        using(var response=await Request(null,HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([valid])))Check(response.StatusCode==HttpStatusCode.Unauthorized,"anonymous archive write denied");
        using(var response=await Request(tokens["history-apk-1"],HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([valid with{Ciphertext=Convert.ToBase64String(new byte[64])}])))Check(response.StatusCode==HttpStatusCode.BadRequest,"ciphertext substitution without new root signature denied");
        using(var response=await Request(existingTokens["bob-hybrid"],HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([valid])))Check(response.StatusCode==HttpStatusCode.BadRequest,"another authenticated account cannot upload a foreign root archive");
        var statuses=await Task.WhenAll(Enumerable.Range(0,12).Select(async index=>{using var response=await Request(tokens[index%2==0?"history-apk-1":"history-apk-2"],HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([valid]));return response.StatusCode;}));
        Check(statuses.All(status=>status==HttpStatusCode.OK),"simultaneous phone writers converge idempotently");
        await using(var scope=app.Services.CreateAsyncScope()){var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();Check(await db.AccountHistorySync.CountAsync(row=>row.UserId==userId)==1,"concurrent writers retain exactly one immutable ciphertext per message");}
        async Task<int> ReadCount(string token){using var response=await Request(token,HttpMethod.Get,"/account/history-sync?after=0");Check(response.StatusCode==HttpStatusCode.OK,"authenticated session downloads its root archive");Check(response.Headers.CacheControl?.NoStore==true,"private history archive is not cacheable");using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync());return json.RootElement.GetProperty("messages").GetArrayLength();}
        var counts=await Task.WhenAll(tokens.Values.Select(ReadCount));Check(counts.All(count=>count==1),"2 APK plus Web and EXE receive the same immutable root-backed history");
        using(var response=await Request(tokens["history-web"],HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([Row("oneview"),Row("expired"),Row("deleted")]))){using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync());Check(response.StatusCode==HttpStatusCode.OK&&json.RootElement.GetProperty("accepted").GetArrayLength()==0,"one-view, expired and deleted messages never enter the account archive");}
        using(var response=await Request(tokens["history-web"],HttpMethod.Post,"/account/history-sync",new AccountHistoryUpload([Sign(valid with{ConversationId="forged-conversation"})]))){using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync());Check(json.RootElement.GetProperty("accepted").GetArrayLength()==0,"even a valid root signature cannot substitute authoritative message context");}
        await using(var scope=app.Services.CreateAsyncScope()){var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();var conversation=await db.Conversations.SingleAsync(row=>row.Id==chatId);conversation.Participants.Single(row=>row.UserId==userId).RemovedAt=DateTimeOffset.UtcNow;await db.SaveChangesAsync();}
        Check(await ReadCount(tokens["history-web"])==0,"removed conversation membership cannot recover archived plaintext");
        await using(var scope=app.Services.CreateAsyncScope()){var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();var conversation=await db.Conversations.SingleAsync(row=>row.Id==chatId);conversation.Participants.Single(row=>row.UserId==userId).RemovedAt=null;await db.Devices.Where(row=>row.UserId==userId).ExecuteUpdateAsync(update=>update.SetProperty(row=>row.RevokedAt,DateTimeOffset.UtcNow));await db.SaveChangesAsync();}
        using(var response=await Request(tokens["history-web"],HttpMethod.Get,"/account/history-sync"))Check(response.StatusCode==HttpStatusCode.Unauthorized,"revoked device immediately loses archive access");
        await Enroll("history-reentered-web");Check(await ReadCount(tokens["history-reentered-web"])==1,"automatic root recovery remains possible after every previous device was revoked");
        await using(var scope=app.Services.CreateAsyncScope()){var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();var message=await db.Messages.SingleAsync(row=>row.Id==valid.MessageId);message.Receipts.Add(new DeliveryReceipt{UserId=userId,DeviceId="history-reentered-web",DeletedAt=DateTimeOffset.UtcNow});await db.SaveChangesAsync();}
        Check(await ReadCount(tokens["history-reentered-web"])==0,"a later deletion suppresses an archive that was already uploaded");
        Console.WriteLine($"PASS {checks} PostgreSQL account history synchronization checks");
    }
}
