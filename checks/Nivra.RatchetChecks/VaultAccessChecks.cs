using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;

public static class VaultAccessChecks
{
    public static async Task Run(WebApplication app,Dictionary<string,string> tokens)
    {
        using var client=new HttpClient{BaseAddress=new Uri(app.Urls.Single())};
        int checks=0;
        void Check(bool value,string label){if(!value)throw new InvalidOperationException(label);checks++;Console.WriteLine("PASS Vault "+label);}
        async Task<HttpResponseMessage> Send(string actor,HttpMethod method,string path,object? body=null)
        {
            using var request=new HttpRequestMessage(method,path);
            request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",tokens[actor]);
            if(body!=null)request.Content=JsonContent.Create(body);
            return await client.SendAsync(request);
        }
        async Task<T> Read<T>(HttpResponseMessage response)
        {
            if(!response.IsSuccessStatusCode)throw new InvalidOperationException($"Vault HTTP {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
            return (await response.Content.ReadFromJsonAsync<T>())!;
        }
        const string pin="v9-isolated-fixture-pin", bob="usr-lab-bob";
        async Task<VaultRoomResponse> Create(VaultAccessMode mode,string? value)
        {
            using var response=await Send("alice",HttpMethod.Post,"/vault/rooms",new CreateVaultRoomRequest("Sala de prueba",value,mode,VaultRetentionMode.Persistent,null,[bob],null));
            return await Read<VaultRoomResponse>(response);
        }
        var legacy=await Create(VaultAccessMode.InviteOnly,pin);
        Check(legacy.RequiresPin,"old invitation-only rooms retain a PIN requirement");
        using(var response=await Send("bob",HttpMethod.Post,$"/vault/rooms/{legacy.Id}/join",new JoinVaultRoomRequest(null)))
            Check(response.StatusCode==HttpStatusCode.Forbidden,"missing PIN is denied without invalidating the signed-in session");
        using(var response=await Send("bob",HttpMethod.Post,$"/vault/rooms/{legacy.Id}/join",new JoinVaultRoomRequest(pin)))
            Check((await Read<VaultRoomResponse>(response)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Active,"legacy room still accepts the correct PIN");
        var simple=await Create(VaultAccessMode.InviteOnly,null);
        Check(!simple.RequiresPin,"new invitation-only room can open without a PIN");
        using(var restricted=await Send("alice",HttpMethod.Post,$"/vault/rooms/{simple.Id}/invite-links",new CreateVaultInviteLinkRequest(3600,2,true)))
        {
            var code=(await Read<VaultInviteLinkResponse>(restricted)).Code;
            using var accepted=await Send("bob",HttpMethod.Post,"/vault/invites/"+Uri.EscapeDataString(code)+"/accept",new AcceptVaultInviteRequest(null));
            Check((await Read<VaultRoomResponse>(accepted)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Waiting,"link-level approval applies to an invitation-only room");
            using var retry=await Send("bob",HttpMethod.Post,$"/vault/rooms/{simple.Id}/join",new JoinVaultRoomRequest(null));
            Check((await Read<VaultRoomResponse>(retry)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Waiting,"a direct room route cannot bypass approval required by its link");
        }
        var room=await Create(VaultAccessMode.WaitingRoom,pin);
        using(var response=await Send("stranger",HttpMethod.Post,$"/vault/rooms/{room.Id}/join",new JoinVaultRoomRequest(pin)))
            Check(response.StatusCode==HttpStatusCode.Forbidden,"knowing the room PIN does not replace an invitation");
        using(var response=await Send("bob",HttpMethod.Post,$"/vault/rooms/{room.Id}/join",new JoinVaultRoomRequest(pin)))
            Check((await Read<VaultRoomResponse>(response)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Waiting,"a direct invitation cannot bypass owner approval");
        using(var response=await Send("bob",HttpMethod.Get,$"/vault/rooms/{room.Id}/voice-token"))
            Check(response.StatusCode==HttpStatusCode.Forbidden,"waiting member cannot obtain room audio credentials");
        using(var response=await Send("bob",HttpMethod.Post,$"/vault/rooms/{room.Id}/members/{bob}/approve",new{}))
            Check(response.StatusCode==HttpStatusCode.NotFound,"invitee cannot approve their own access");
        using(var response=await Send("alice",HttpMethod.Post,$"/vault/rooms/{room.Id}/members/{bob}/approve",new{}))
            Check((await Read<VaultRoomResponse>(response)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Active,"owner approval activates membership");
        using var created=await Send("alice",HttpMethod.Post,$"/vault/rooms/{room.Id}/invite-links",new CreateVaultInviteLinkRequest(3600,1,true));
        var invite=await Read<VaultInviteLinkResponse>(created);
        var invitePath="/vault/invites/"+Uri.EscapeDataString(invite.Code)+"/accept";
        using(var response=await Send("bob",HttpMethod.Post,invitePath,new AcceptVaultInviteRequest(pin)))
            Check((await Read<VaultRoomResponse>(response)).Members.Single(m=>m.UserId==bob).Status==VaultMemberStatus.Active,"opening an invitation again keeps prior approval");
        var redeemed=await Task.WhenAll(new[]{"carol","stranger"}.Select(async actor=>
        {using var response=await Send(actor,HttpMethod.Post,invitePath,new AcceptVaultInviteRequest(pin));return response.StatusCode;}));
        Check(redeemed.Count(s=>s==HttpStatusCode.OK)==1&&redeemed.Count(s=>s==HttpStatusCode.Gone)==1,"concurrent claims cannot exceed one allowed invitation use");
        Console.WriteLine($"PASS {checks} PostgreSQL Vault access checks");
    }
}
