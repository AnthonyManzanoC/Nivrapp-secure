using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Reflection;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

public static class VaultViewCloseChecks
{
    // Exercise the production hub methods with a real authenticated HTTP request and database.
    public static void MapFixture(WebApplication app) => app.MapPost("/fixture/vault-view/{action}/{roomId}",
        async Task<IResult>(string action, string roomId, HttpContext http, NivraDbContext db, INivraStore store,
            EncryptedFileStorage storage) =>
        {
            if (http.GetCurrentUser() is not { } user) return Results.Unauthorized();
            if (action is not ("close" or "join" or "disconnect")) return Results.NotFound();
            // Simulate revocation after an already authenticated connection was established.
            if (http.Request.Query.ContainsKey("revoke"))
            {
                (await db.Sessions.SingleAsync(row => row.Id == user.SessionId)).RevokedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(); db.ChangeTracker.Clear();
            }
            var context = new VaultFixtureContext(user);
            context.Items["vault_rooms"] = new HashSet<string> { roomId };
            var groups = new ViewFixtureGroups();
            var clients = DispatchProxy.Create<IHubCallerClients, ViewFixtureClients>();
            var hub = new NivraHub(null!, store, db, null!, new RealtimePresence(), storage, null!, null!,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<NivraHub>.Instance, TimeProvider.System)
                { Context = context, Groups = groups, Clients = clients };
            try
            {
                if (action == "close") await hub.CloseVaultRoomView(roomId);
                else if (action == "join") await hub.JoinVaultRoom(roomId);
                else await hub.OnDisconnectedAsync(null);
            }
            catch (HubException) { return Results.StatusCode(403); }
            return Results.Ok(new ViewResult(groups.Added, groups.Removed,
                ((HashSet<string>)context.Items["vault_rooms"]!).Contains(roomId)));
        });

    public static async Task Run(WebApplication app)
    {
        const string owner = "usr-vault-view-owner", member = "usr-vault-view-member", stranger = "usr-vault-view-stranger";
        var tokens = new Dictionary<string, string>();
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var store = scope.ServiceProvider.GetRequiredService<INivraStore>();
            foreach (var id in new[] { owner, member, stranger })
            {
                var user = new UserAccount { Id=id, Alias=id, PasswordHash=new("fixture",1,"fixture","fixture"),CreatedAt=DateTimeOffset.UtcNow,UpdatedAt=DateTimeOffset.UtcNow };
                db.Users.Add(user); await db.SaveChangesAsync();
                foreach (var suffix in id == owner ? new[] { "", "-revoked-close", "-revoked-join" } : new[] { "" })
                {
                    var device = new DeviceRecord { Id="dev-"+id+suffix, UserId=id,Name="Isolated Vault view fixture",IsTrusted=true,CreatedAt=DateTimeOffset.UtcNow };
                    db.Devices.Add(device); await db.SaveChangesAsync();
                    tokens[id+suffix]=(await scope.ServiceProvider.GetRequiredService<TokenService>().CreateSessionAsync(store,user,device,null,null)).AccessToken;
                }
            }
            foreach (var name in new[] {"persistent","ttl","burn","expired","closed","waiting","disconnect-persistent","disconnect-burn"})
            {
                var roomId="vault-view-"+name;
                db.VaultRooms.Add(new VaultRoom {Id=roomId,OwnerUserId=owner,Name="Isolated view fixture",CreatedAt=DateTimeOffset.UtcNow,UpdatedAt=DateTimeOffset.UtcNow,
                    RetentionMode=name.Contains("burn")?VaultRetentionMode.BurnOnExit:name is "ttl" or "expired"?VaultRetentionMode.ExpiresAfterTtl:VaultRetentionMode.Persistent,
                    ExpiresAt=name=="expired"?DateTimeOffset.UtcNow.AddMinutes(-1):name=="ttl"?DateTimeOffset.UtcNow.AddMinutes(15):null,
                    ClosedAt=name=="closed"?DateTimeOffset.UtcNow:null});
                foreach (var id in new[] {owner,member}) db.VaultRoomMembers.Add(new VaultRoomMember {Id=roomId+"-"+id,VaultRoomId=roomId,UserId=id,
                    Status=name=="waiting"&&id==member?VaultMemberStatus.Waiting:VaultMemberStatus.Active,CreatedAt=DateTimeOffset.UtcNow});
            }
            await db.SaveChangesAsync();
        }
        using var client = new HttpClient { BaseAddress=new Uri(app.Urls.Single()) };
        int count=0;
        void Check(bool value,string label) { if(!value)throw new InvalidOperationException(label);count++;Console.WriteLine("PASS Vault view "+label); }
        async Task<HttpResponseMessage> Send(string? actor,string action,string name,bool revoke=false)
        {
            using var request=new HttpRequestMessage(HttpMethod.Post,$"/fixture/vault-view/{action}/vault-view-{name}"+(revoke?"?revoke=1":""));
            if(actor is not null)request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",tokens[actor]);
            return await client.SendAsync(request);
        }
        async Task CheckOpenState(string name,bool open,VaultMemberStatus status)
        {
            await using var scope=app.Services.CreateAsyncScope();var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var room=await db.VaultRooms.AsNoTracking().SingleAsync(row=>row.Id=="vault-view-"+name);
            Check((room.ClosedAt is null)==open&&room.OwnerUserId==owner,"room owner and retention survive "+name);
            var membership=await db.VaultRoomMembers.AsNoTracking().SingleAsync(row=>row.VaultRoomId==room.Id&&row.UserId==owner);
            Check(membership.Status==status,"owner membership remains correct for "+name);
        }
        foreach (var name in new[] {"persistent","ttl"})
        {
            foreach (var actor in new[] {owner,member})
            {
                using var closed=await Send(actor,"close",name);
                var state=await closed.Content.ReadFromJsonAsync<ViewResult>();
                Check(closed.StatusCode==HttpStatusCode.OK&&state?.Removed==1&&state.Tracked==false,"closing "+name+" only detaches the current connection");
                await CheckOpenState(name,true,VaultMemberStatus.Active);
                using var joined=await Send(actor,"join",name);
                var reopened=await joined.Content.ReadFromJsonAsync<ViewResult>();
                Check(joined.StatusCode==HttpStatusCode.OK&&reopened?.Added==1&&reopened.Tracked,"same account can reopen "+name+" with its existing membership");
            }
        }
        foreach(var name in new[]{"burn","expired","closed"})
        {
            using var rejected=await Send(owner,"close",name);
            Check(rejected.StatusCode==HttpStatusCode.Forbidden,"soft close cannot bypass "+name+" retention");
        }
        foreach(var name in new[]{"expired","closed"})
        {
            using var rejected=await Send(owner,"join",name);
            Check(rejected.StatusCode==HttpStatusCode.Forbidden,"joining cannot revive "+name+" content");
        }
        using(var waiting=await Send(member,"close","waiting")) Check(waiting.StatusCode==HttpStatusCode.Forbidden,"waiting membership cannot close an active view");
        using(var foreign=await Send(stranger,"close","persistent")) Check(foreign.StatusCode==HttpStatusCode.Forbidden,"another account cannot detach a room view");
        using(var anonymous=await Send(null,"close","persistent")) Check(anonymous.StatusCode==HttpStatusCode.Unauthorized,"anonymous close is denied");
        using(var revoked=await Send(owner+"-revoked-close","close","persistent",true)) Check(revoked.StatusCode==HttpStatusCode.Forbidden,"a connection revoked after authentication cannot close a view");
        using(var revoked=await Send(owner+"-revoked-join","join","persistent",true)) Check(revoked.StatusCode==HttpStatusCode.Forbidden,"a connection revoked after authentication cannot rejoin a room");
        using(var disconnected=await Send(owner,"disconnect","disconnect-persistent")) Check(disconnected.StatusCode==HttpStatusCode.OK,"a persistent room survives transport disconnection");
        await CheckOpenState("disconnect-persistent",true,VaultMemberStatus.Active);
        using(var disconnected=await Send(owner,"disconnect","disconnect-burn")) Check(disconnected.StatusCode==HttpStatusCode.OK,"burn-on-exit cleanup runs on disconnect");
        await CheckOpenState("disconnect-burn",false,VaultMemberStatus.Left);
        Console.WriteLine($"PASS {count} PostgreSQL Vault view close/reopen checks");
    }

    public sealed record ViewResult(int Added,int Removed,bool Tracked);
    public sealed class ViewFixtureGroups : IGroupManager
    {
        public int Added,Removed;
        public Task AddToGroupAsync(string connectionId,string groupName,CancellationToken cancellationToken=default) {Added++;return Task.CompletedTask;}
        public Task RemoveFromGroupAsync(string connectionId,string groupName,CancellationToken cancellationToken=default) {Removed++;return Task.CompletedTask;}
    }
    public class ViewFixtureClients : DispatchProxy
    {
        private readonly ViewSink sink=new();
        protected override object? Invoke(MethodInfo? method,object?[]? arguments) => sink;
    }
    public sealed class ViewSink : IClientProxy { public Task SendCoreAsync(string method,object?[] args,CancellationToken cancellationToken=default)=>Task.CompletedTask; }
}
