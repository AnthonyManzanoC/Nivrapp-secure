using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

public static class CallAnswerChecks
{
    public static async Task Run(IServiceProvider services)
    {
        const string callId="cal-v9-answer-race",alice="usr-lab-alice",bob="usr-lab-bob";
        var now=DateTimeOffset.UtcNow;
        void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);Console.WriteLine("PASS call answer "+message);}
        await using(var scope=services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var call=new CallSession{Id=callId,InitiatorUserId=alice,InitiatorDeviceId="dev-lab-alice",InitiatorSessionId="caller-web",Type=CallType.Video,Status=CallStatus.Ringing,StartedAt=now,ParticipantUserIds=[alice,bob]};
            db.Calls.Add(call);CallPushOutbox.Enqueue(db,call);
            var wake=db.CallPushOutbox.Local.Single();wake.CompletedAt=now; // Both devices already received the wake-up.
            await db.SaveChangesAsync();
        }
        async Task<bool> Claim(string deviceId,string clientSession)
        {
            await using var scope=services.CreateAsyncScope();var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            return await CallCoordination.RunAsync(db,async()=>
            {
                await using var transaction=await CallCoordination.LockAsync(db,"call:"+callId,CancellationToken.None);
                var call=await db.Calls.SingleAsync(c=>c.Id==callId);
                if(!CallCoordination.TryClaim(call,bob,deviceId,clientSession))return false;
                call.Status=CallStatus.Active;
                await db.SaveChangesAsync();
                await CallPushOutbox.AcknowledgeAsync(db,call.Id,bob,deviceId,now.AddSeconds(1),CancellationToken.None);
                await transaction.CommitAsync();return true;
            });
        }
        var claims=await Task.WhenAll(Claim("dev-lab-bob","phone-session"),Claim("dev-lab-bob-real","desktop-session"));
        Check(claims.Count(won=>won)==1,"only one simultaneous callee device owns the call");
        await using(var scope=services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var call=await db.Calls.AsNoTracking().SingleAsync(c=>c.Id==callId);
            var pending=await db.CallPushOutbox.AsNoTracking().SingleAsync(c=>c.CallId==callId);
            Check(pending.RecipientUserId==bob&&pending.AnsweredDeviceId==call.ParticipantSessions[bob].DeviceId&&pending.CompletedAt==null,"answer schedules a durable, account-specific dismissal even after the wake-up was delivered");
            Check(!CallPushOutbox.ShouldSend(call,pending,now.AddSeconds(2)),"a dismissal never sends a second wake-up");
            var sends=0;
            Check(await CallPushOutbox.DispatchAsync(call,pending,now.AddSeconds(2),(_,_)=>{sends++;return Task.FromResult(false);},CancellationToken.None)==CallPushDelivery.Retry&&sends==1,"temporary provider failure retries the dismissal");
            Check(await CallPushOutbox.DispatchAsync(call,pending,pending.ExpiresAt,(_,_)=>{sends++;return Task.FromResult(true);},CancellationToken.None)==CallPushDelivery.Discard&&sends==1,"expired dismissal cannot affect a later ring");
            Check(await CallPushOutbox.AcknowledgeAsync(db,callId,bob,pending.AnsweredDeviceId!,now.AddSeconds(3),CancellationToken.None)==0,"idempotent answer retry cannot reset the dismissal lease");
        }
    }
}
