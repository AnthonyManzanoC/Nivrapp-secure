using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;

// Uses only the existing isolated loopback fixture; never loads production settings.
public static class CommunityChecks
{
    public static async Task Run(WebApplication app,Dictionary<string,string> tokens)
    {
        var count=0;
        void Check(bool value,string label){if(!value)throw new InvalidOperationException(label);count++;Console.WriteLine("PASS community "+label);}
        using var client=new HttpClient{BaseAddress=new Uri(app.Urls.Single())};
        async Task<HttpResponseMessage> Request(string? actor,HttpMethod method,string path,object? body=null)
        {
            using var request=new HttpRequestMessage(method,path);
            if(body!=null)request.Content=JsonContent.Create(body);
            if(actor!=null)request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",tokens[actor]);
            return await client.SendAsync(request);
        }
        async Task<CommunityView> Read(HttpResponseMessage response)
        {
            if(!response.IsSuccessStatusCode)throw new InvalidOperationException($"Community HTTP {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
            return (await response.Content.ReadFromJsonAsync<CommunityView>())!;
        }
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            foreach(var seedId in new[]{"community-existing","community-foreign","community-standalone"})
            {
                var group=new ConversationRecord{Id=seedId,Type=ConversationType.Group,GroupName=seedId,CreatedByUserId="usr-lab-alice",CreatedAt=DateTimeOffset.UtcNow,UpdatedAt=DateTimeOffset.UtcNow};
                group.Participants.Add(new(){UserId="usr-lab-alice",Role=seedId=="community-foreign"?ParticipantRole.Member:ParticipantRole.Owner,JoinedAt=DateTimeOffset.UtcNow});
                group.Participants.Add(new(){UserId="usr-lab-bob",Role=seedId=="community-foreign"?ParticipantRole.Owner:ParticipantRole.Member,JoinedAt=DateTimeOffset.UtcNow});
                db.Conversations.Add(group);
            }
            await db.SaveChangesAsync();
        }
        var draft=new CreateCommunityRequest("Comunidad de prueba","Avisos y grupos",null,["community-existing"],Guid.NewGuid());
        using(var response=await Request(null,HttpMethod.Post,"/communities",draft))Check(response.StatusCode==HttpStatusCode.Unauthorized,"anonymous create denied");
        using(var response=await Request("alice",HttpMethod.Post,"/communities",draft with{RequestId=Guid.Empty}))Check(response.StatusCode==HttpStatusCode.BadRequest,"creation requires a retry identity");
        using(var response=await Request("alice",HttpMethod.Post,"/communities",draft with{GroupIds=["community-foreign"]}))Check(response.StatusCode==HttpStatusCode.Conflict,"must administer every linked group");
        using(var response=await Request("alice",HttpMethod.Post,"/communities",draft with{Photo="data:image/png;base64,c2NyaXB0"}))Check(response.StatusCode==HttpStatusCode.BadRequest,"fake image rejected");
        var replies=await Task.WhenAll(Enumerable.Range(0,6).Select(async _=>{using var r=await Request("alice",HttpMethod.Post,"/communities",draft);return await Read(r);}));
        var community=replies[0];var id=community.Id;
        Check(replies.Select(c=>c.Id).Distinct().Count()==1,"concurrent retries create one community");
        Check(community.MemberCount==2&&community.Groups.Count==1&&community.Role=="Owner","linked group members receive announcements without moving history");
        using(var r=await Request("bob",HttpMethod.Get,"/communities/"+id))Check((await Read(r)).Role=="Member","member sees own community");
        using(var r=await Request("stranger",HttpMethod.Get,"/communities/"+id))Check(r.StatusCode==HttpStatusCode.NotFound,"other account cannot read group metadata");
        using(var r=await Request("stranger",HttpMethod.Get,"/communities"))Check((await r.Content.ReadFromJsonAsync<CommunityView[]>())!.All(c=>c.Id!=id),"list does not disclose private communities");
        using(var r=await Request("bob",HttpMethod.Patch,"/communities/"+id,new UpdateCommunityRequest("Stolen",null,null)))Check(r.StatusCode==HttpStatusCode.NotFound,"member cannot edit community");
        using(var r=await Request("alice",HttpMethod.Patch,"/communities/"+id,new UpdateCommunityRequest("Nombre nuevo","Descripción nueva",null)))Check((await Read(r)).Name=="Nombre nuevo","admin metadata stays synchronized with announcement chat");
        var childDraft=new CreateCommunityGroupRequest("Conversación por temas",[],Guid.NewGuid());
        var children=await Task.WhenAll(Enumerable.Range(0,5).Select(async _=>{using var r=await Request("alice",HttpMethod.Post,$"/communities/{id}/groups/create",childDraft);return await Read(r);}));
        Check(children.All(c=>c.Groups.Count==2),"new child group creation is idempotent under retries");
        var child=children[0].Groups.Single(c=>c.Id!="community-existing").Id;
        var childPath=$"/communities/{id}/groups/{child}";
        var reviewPath=$"{childPath}/requests/usr-lab-bob";
        var submissions=await Task.WhenAll(Enumerable.Range(0,5).Select(async n=>{
            using var r=await Request("bob",HttpMethod.Post,$"{childPath}/{(n%2==0?"request":"join")}",new{});
            return r.StatusCode;
        }));
        Check(submissions.All(status=>status==HttpStatusCode.Accepted),"concurrent requests and older clients require approval");
        using(var r=await Request("bob",HttpMethod.Get,$"/communities/{id}"))
        {
            var group=(await Read(r)).Groups.Single(g=>g.Id==child);
            Check(group.RequestPending&&!group.Joined&&!group.CanReview,"requester sees one pending request without membership");
        }
        using(var r=await Request("bob",HttpMethod.Get,$"/communities/{id}/join-requests"))
            Check((await r.Content.ReadFromJsonAsync<CommunityGroupRequestView[]>())!.Length==0,"members cannot list requests for groups they do not manage");
        using(var r=await Request("bob",HttpMethod.Post,reviewPath,new{accept=true}))
            Check(r.StatusCode==HttpStatusCode.NotFound,"requester cannot approve their own access");
        using(var r=await Request("stranger",HttpMethod.Get,$"/communities/{id}/join-requests"))
            Check(r.StatusCode==HttpStatusCode.NotFound,"outsider cannot see the approval queue");
        using(var r=await Request("alice",HttpMethod.Get,$"/communities/{id}/join-requests"))
            Check((await r.Content.ReadFromJsonAsync<CommunityGroupRequestView[]>())!.Single().UserId=="usr-lab-bob","group admin sees one request after concurrent retries");
        using(var r=await Request("alice",HttpMethod.Post,reviewPath,new{}))
            Check(r.StatusCode==HttpStatusCode.BadRequest,"review requires an explicit decision");
        var approvals=await Task.WhenAll(Enumerable.Range(0,4).Select(async _=>{
            using var r=await Request("alice",HttpMethod.Post,reviewPath,new{accept=true});
            return r.StatusCode;
        }));
        Check(approvals.All(status=>status==HttpStatusCode.NoContent),"parallel approvals grant membership once");
        using(var r=await Request("bob",HttpMethod.Get,$"/communities/{id}"))
        {
            var group=(await Read(r)).Groups.Single(g=>g.Id==child);
            Check(group.Joined&&!group.RequestPending&&group.MemberCount==2,"approval enables the chat and clears the pending state");
        }
        using(var r=await Request("stranger",HttpMethod.Post,$"/communities/{id}/groups/{child}/join",new{}))Check(r.StatusCode==HttpStatusCode.NotFound,"outsider cannot join by guessing IDs");
        using(var r=await Request("bob",HttpMethod.Post,$"/communities/{id}/groups/community-standalone/join",new{}))Check(r.StatusCode==HttpStatusCode.NotFound,"cannot join an unrelated group through a community");
        using(var r=await Request("bob",HttpMethod.Post,$"/conversations/{id}/invite-links",new{}))Check(r.StatusCode==HttpStatusCode.NotFound,"only administrators can create invitation links");
        using(var r=await Request("alice",HttpMethod.Post,$"/conversations/{id}/invite-links",new{}))
        {
            Check(r.StatusCode==HttpStatusCode.OK,"administrator creates a revocable community invitation");
            var code=(await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString();
            using var preview=await Request("stranger",HttpMethod.Post,"/group-invites/preview",new{code});
            Check((await preview.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("communityId").GetString()==id,"invitation preview identifies the community");
            using var accepted=await Request("stranger",HttpMethod.Post,"/group-invites/accept",new{code});
            Check((await accepted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("communityId").GetString()==id,"accepted invitation opens the community rather than an unrelated chat");
            using var membership=await Request("stranger",HttpMethod.Get,"/communities/"+id);
            Check((await Read(membership)).Role=="Member","invitation cannot grant administrator privileges");
        }
        using(var r=await Request("stranger",HttpMethod.Post,$"{childPath}/request",new{}))
            Check(r.StatusCode==HttpStatusCode.Accepted,"new community member may request access to the child group");
        using(var r=await Request("alice",HttpMethod.Post,$"{childPath}/requests/usr-lab-stranger",new{accept=false}))
            Check(r.StatusCode==HttpStatusCode.NoContent,"group admin can decline");
        using(var r=await Request("stranger",HttpMethod.Post,$"{childPath}/request",new{}))
            Check(r.StatusCode==HttpStatusCode.Conflict,"declined request cannot immediately flood the admin queue");
        using(var r=await Request("alice",HttpMethod.Post,$"/communities/{id}/groups",new LinkCommunityGroupRequest("community-existing")))Check((await Read(r)).Groups.Count==2,"link retry does not duplicate membership");
        using(var r=await Request("bob",HttpMethod.Delete,$"/communities/{id}/groups/{child}"))Check(r.StatusCode==HttpStatusCode.NotFound,"member cannot unlink a group");
        using(var r=await Request("alice",HttpMethod.Delete,$"/communities/{id}/groups/{child}"))Check(r.StatusCode==HttpStatusCode.NoContent,"admin can unlink without deleting the conversation");
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            Check(await db.Conversations.AnyAsync(c=>c.Id==child),"unlinked conversation and its existing data survive");
            var parent=await db.Conversations.SingleAsync(c=>c.Id==id);
            Check(parent.Settings.SendMessages=="admins","announcements enforce administrators only");
        }
        using(var r=await Request("bob",HttpMethod.Post,$"/communities/{id}/leave",new{}))Check(r.StatusCode==HttpStatusCode.NoContent,"member leaves community and linked groups");
        using(var r=await Request("bob",HttpMethod.Get,"/communities/"+id))Check(r.StatusCode==HttpStatusCode.NotFound,"departed member cannot read community again");
        using(var r=await Request("bob",HttpMethod.Post,$"/communities/{id}/groups/community-existing/join",new{}))Check(r.StatusCode==HttpStatusCode.NotFound,"departure cannot be bypassed by self join");
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var linked=await db.Conversations.Include(c=>c.Participants).SingleAsync(c=>c.Id=="community-existing");
            Check(linked.Participants.Single(p=>p.UserId=="usr-lab-bob").RemovedAt!=null,"linked group removal is committed with parent departure");
            var independent=await db.Conversations.Include(c=>c.Participants).SingleAsync(c=>c.Id==child);
            Check(independent.Participants.Single(p=>p.UserId=="usr-lab-bob").RemovedAt==null,"unlinked groups retain their independent membership");
            Check(await db.Conversations.AnyAsync(c=>c.Id=="chat-lab"),"existing ratchet history fixture remains intact");
        }
        Console.WriteLine($"PASS {count} PostgreSQL community and authorization checks");
    }
}
