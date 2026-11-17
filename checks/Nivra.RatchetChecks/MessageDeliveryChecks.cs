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

public static class MessageDeliveryChecks
{
    public static async Task Run(WebApplication app, IReadOnlyDictionary<string,string> tokens)
    {
        const string chatId="message-delivery-lab", otherChatId="message-delivery-other";
        const string senderUser="usr-lab-alice", peerUser="usr-lab-bob";
        const string senderDevice="dev-lab-alice-hybrid", peerDevice="dev-lab-bob-hybrid";
        var json=new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var passed=0;
        void Check(bool condition,string label){if(!condition)throw new InvalidOperationException(label);passed++;Console.WriteLine("PASS "+label);}
        async Task Mutate(Func<NivraDbContext,Task> action)
        {
            await using var scope=app.Services.CreateAsyncScope();
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            await action(db);await db.SaveChangesAsync();
        }
        await Mutate(db=>
        {
            foreach(var id in new[]{chatId,otherChatId})
            {
                var chat=new ConversationRecord {Id=id,Type=ConversationType.Direct,CreatedByUserId=senderUser,CreatedAt=DateTimeOffset.UtcNow,UpdatedAt=DateTimeOffset.UtcNow};
                chat.Participants.Add(new ConversationParticipant {UserId=senderUser,JoinedAt=DateTimeOffset.UtcNow});
                chat.Participants.Add(new ConversationParticipant {UserId=peerUser,JoinedAt=DateTimeOffset.UtcNow});
                db.Conversations.Add(chat);
            }
            return Task.CompletedTask;
        });
        string senderIdentity;
        int senderRegistration;
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var sender=await db.Set<RatchetPilotDevice>().SingleAsync(row=>row.DeviceId==senderDevice);
            senderIdentity=sender.IdentityKey;senderRegistration=sender.RegistrationId;
            Check(await db.Devices.AnyAsync(row=>row.UserId==peerUser&&row.IsTrusted&&row.RevokedAt==null
                && !db.Set<RatchetPilotDevice>().Any(registration=>registration.DeviceId==row.Id&&registration.AddressMode==2)),
                "delivery fixture contains an extra trusted legacy device that must not block a ready hybrid device");
        }
        string Binary(int length)=>Convert.ToBase64String(RandomNumberGenerator.GetBytes(length));
        SendMessageRequest Frame(string id)
        {
            var digest=Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(id))).TrimEnd('=').Replace('+','-').Replace('/','_');
            var ownHeader=JsonSerializer.Serialize(new {v=4,alg=RatchetMessagePolicy.HybridAlgorithm,senderDeviceId=senderDevice,recipientDeviceId=senderDevice,identityKey=senderIdentity,registrationId=senderRegistration,local=true});
            var header=JsonSerializer.Serialize(new {v=4,alg=RatchetMessagePolicy.HybridAlgorithm,senderDeviceId=senderDevice,recipientDeviceId=peerDevice,identityKey=senderIdentity,registrationId=senderRegistration,payloadIv=Binary(12),payloadCiphertext=Binary(32)});
            var ciphertext=JsonSerializer.Serialize(new {v=3,suite="NIVRA-PQXDH-MLKEM768-A256GCM-1",type=3,keyMessage=Binary(32),iv=Binary(12),ciphertext=Binary(32),context=new {conversationId=chatId,messageId=digest,sender=senderDevice+".1",recipient=peerDevice+".1"}});
            return new(id,MessageKind.Text,[new(senderUser,senderDevice,"local-history-v1",ownHeader,null),new(peerUser,peerDevice,ciphertext,header,null)],null,null,false);
        }
        using var client=new HttpClient {BaseAddress=new Uri(app.Urls.Single()),Timeout=TimeSpan.FromSeconds(45)};
        async Task<HttpResponseMessage> Post(string? actor,string path,object body)
        {
            using var request=new HttpRequestMessage(HttpMethod.Post,path){Content=JsonContent.Create(body,options:json)};
            if(actor is not null)request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",tokens[actor]);
            return await client.SendAsync(request);
        }
        var sendPath=$"/conversations/{chatId}/messages/ratchet";
        var frame=Frame("delivery-"+Guid.NewGuid().ToString("N"));
        using(var denied=await Post(null,sendPath,frame))Check(denied.StatusCode==HttpStatusCode.Unauthorized,"real message endpoint rejects an anonymous encrypted send");
        using(var omitted=await Post("alice-hybrid",sendPath,frame with {Recipients=[frame.Recipients[0]]}))
            Check(omitted.StatusCode==HttpStatusCode.BadRequest,"a ready-device subset must still include every conversation participant");
        using(var invalidLegacy=await Post("alice-hybrid",sendPath,frame with {Recipients=[frame.Recipients[0],frame.Recipients[1] with {DeviceId="dev-lab-bob"}]}))
            Check(invalidLegacy.StatusCode==HttpStatusCode.BadRequest,"an unregistered legacy recipient never permits a hybrid downgrade");
        string messageId;
        using(var sent=await Post("alice-hybrid",sendPath,frame))
        {
            Check(sent.StatusCode==HttpStatusCode.Created,"real hybrid message sends with one ready device per participant while older linked devices remain offline");
            messageId=(await sent.Content.ReadFromJsonAsync<MessageResponse>(json))!.Id;
        }
        var retries=await Task.WhenAll(Enumerable.Range(0,12).Select(async _=>
        {
            using var response=await Post("alice-hybrid",sendPath,frame);
            if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("An idempotent real send retry did not return its stored acknowledgement.");
            return (await response.Content.ReadFromJsonAsync<MessageResponse>(json))!.Id;
        }));
        Check(retries.All(id=>id==messageId),"twelve concurrent retries recover the same persisted message acknowledgement");
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            Check(await db.Messages.CountAsync(row=>row.SenderUserId==senderUser&&row.ClientMessageId==frame.ClientMessageId)==1,
                "connection-loss retries cannot create duplicate persisted messages");
        }
        using(var conflict=await Post("alice-hybrid",$"/conversations/{otherChatId}/messages/ratchet",frame))
            Check(conflict.StatusCode==HttpStatusCode.Conflict,"a durable message id cannot be redirected into another conversation");
        using(var receipt=await Post("bob-hybrid",$"/messages/{messageId}/receipt",new ReceiptRequest(ReceiptKind.Delivered,null)))
        {
            Check(receipt.StatusCode==HttpStatusCode.OK,"recipient acknowledges delivery through the real receipt endpoint");
            var restored=(await receipt.Content.ReadFromJsonAsync<MessageResponse>(json))!;
            Check(restored.Receipts.Single(row=>row.UserId==peerUser&&row.DeviceId==peerDevice).DeliveredAt is not null,
                "delivered status comes from the recipient acknowledgement rather than local send success");
        }
        using(var read=await Post("bob-hybrid",$"/messages/{messageId}/receipt",new ReceiptRequest(ReceiptKind.Read,false)))
            Check(read.StatusCode==HttpStatusCode.OK,"recipient can confirm read after persisted delivery");
        // Exercise the production HTTP/transaction/deduplication boundary under
        // bounded parallel load. Frames are synthetic opaque protocol fixtures;
        // the separate WASM tests exercise actual hybrid encryption.
        const int loadMessages=240,concurrentPairs=8;
        var loadPrefix="delivery-load-"+Guid.NewGuid().ToString("N")+"-";
        var frames=Enumerable.Range(0,loadMessages).Select(index=>Frame(loadPrefix+index)).ToArray();
        using var loadGate=new SemaphoreSlim(concurrentPairs,concurrentPairs);
        var elapsed=System.Diagnostics.Stopwatch.StartNew();
        var persistedIds=await Task.WhenAll(frames.Select(async loadFrame=>
        {
            await loadGate.WaitAsync();
            try
            {
                var responses=await Task.WhenAll(Post("alice-hybrid",sendPath,loadFrame),Post("alice-hybrid",sendPath,loadFrame));
                try
                {
                    if(responses.Any(response=>response.StatusCode is not (HttpStatusCode.Created or HttpStatusCode.OK)))
                        throw new InvalidOperationException("Bounded load send failed: "+string.Join(',',responses.Select(response=>(int)response.StatusCode)));
                    var acknowledgements=await Task.WhenAll(responses.Select(response=>response.Content.ReadFromJsonAsync<MessageResponse>(json)));
                    if(acknowledgements[0]!.Id!=acknowledgements[1]!.Id)throw new InvalidOperationException("Concurrent duplicate load send produced two message identifiers.");
                    return acknowledgements[0]!.Id;
                }
                finally {foreach(var response in responses)response.Dispose();}
            }
            finally {loadGate.Release();}
        }));
        elapsed.Stop();
        Check(persistedIds.Distinct().Count()==loadMessages,"bounded load returns one stable acknowledgement per message across 480 concurrent original and duplicate HTTP sends");
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            Check(await db.Messages.CountAsync(row=>row.SenderUserId==senderUser&&row.ClientMessageId.StartsWith(loadPrefix))==loadMessages,
                "bounded concurrent load persists 240 unique messages without loss or duplicate rows");
            Check(await db.MessagePushOutbox.CountAsync(row=>persistedIds.Contains(row.MessageId)&&row.RecipientUserId==peerUser)==loadMessages,
                "each committed load message has one atomically persisted receiving-user notification job");
        }
        using(var outsider=await Post("stranger",sendPath,Frame(loadPrefix+"outsider")))
            Check(outsider.StatusCode==HttpStatusCode.NotFound,"a different account cannot inject a message into the loaded conversation");
        using(var outsider=await Post("stranger",$"/messages/{persistedIds[0]}/receipt",new ReceiptRequest(ReceiptKind.Delivered,null)))
            Check(outsider.StatusCode==HttpStatusCode.NotFound,"a different account cannot forge delivery acknowledgements during load");
        foreach(var id in persistedIds.Take(24))
        {
            using var receipt=await Post("bob-hybrid",$"/messages/{id}/receipt",new ReceiptRequest(ReceiptKind.Delivered,null));
            if(receipt.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("A load message could not be acknowledged by its recipient.");
        }
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();var received=persistedIds.Take(24).ToList();
            Check(await db.Messages.CountAsync(row=>received.Contains(row.Id)&&row.Receipts.Any(receipt=>receipt.UserId==peerUser&&receipt.DeviceId==peerDevice&&receipt.DeliveredAt!=null))==24,
                "recipient acknowledgements persist correctly after the concurrent load burst");
        }
        Console.WriteLine($"LOAD messages={loadMessages} httpSends={loadMessages*2} maxConcurrentRequests={concurrentPairs*2} elapsedMs={elapsed.ElapsedMilliseconds} errors=0 duplicates=0 lost=0; isolated PostgreSQL synthetic frames, not a production capacity estimate");
        await Mutate(async db=>(await db.Devices.SingleAsync(row=>row.Id==peerDevice)).RevokedAt=DateTimeOffset.UtcNow);
        try
        {
            using var revoked=await Post("alice-hybrid",sendPath,Frame("revoked-"+Guid.NewGuid().ToString("N")));
            Check(revoked.StatusCode==HttpStatusCode.BadRequest,"revoking the selected device prevents later sends instead of silently dropping its participant");
        }
        finally {await Mutate(async db=>(await db.Devices.SingleAsync(row=>row.Id==peerDevice)).RevokedAt=null);}
        Console.WriteLine($"PASS {passed} real PostgreSQL message send, retry and receipt checks");
    }
}
