using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

public static class AccountIdentityChecks
{
    public static async Task Run(WebApplication app,Dictionary<string,string> tokens)
    {
        const string userId="usr-lab-bob",deviceId="dev-lab-bob-hybrid";
        int count=0;void Check(bool valid,string label){if(!valid)throw new InvalidOperationException(label);count++;Console.WriteLine("PASS account identity "+label);}
        using var client=new HttpClient{BaseAddress=new Uri(app.Urls.Single())};
        async Task<HttpResponseMessage> Request(string? actor,HttpMethod method,string path,object? body=null){using var message=new HttpRequestMessage(method,path);if(actor!=null)message.Headers.Authorization=new AuthenticationHeaderValue("Bearer",tokens[actor]);if(body!=null)message.Content=JsonContent.Create(body);return await client.SendAsync(message);}
        using var key=ECDsa.Create(ECCurve.NamedCurves.nistP256);var point=key.ExportParameters(false).Q;
        string Coordinate(byte[] value)=>Convert.ToBase64String(value).TrimEnd('=').Replace('+','-').Replace('/','_');
        var coords=Coordinate(point.X!)+":"+Coordinate(point.Y!);
        var legacy=JsonSerializer.Serialize(new{kty="EC",crv="P-256",x=Coordinate(point.X!),y=Coordinate(point.Y!)});
        string hybrid;
        await using(var scope=app.Services.CreateAsyncScope()){
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();var device=await db.Devices.SingleAsync(x=>x.Id==deviceId);device.KeyBundle.IdentityKey=legacy;
            hybrid=(await db.Set<RatchetPilotDevice>().SingleAsync(x=>x.DeviceId==deviceId)).IdentityKey;await db.SaveChangesAsync();
        }
        string Wrapped(string method)=>JsonSerializer.Serialize(new{v=1,method,salt=Convert.ToBase64String(new byte[32]),iv=Convert.ToBase64String(new byte[12]),ciphertext=Convert.ToBase64String(new byte[256]),iterations=method=="password"?600000:0});
        var identity=new AccountRootPublic(1,coords,deviceId,hybrid,coords,Convert.ToBase64String(new byte[64]));
        var backup=new AccountIdentityBackup(identity,Wrapped("password"),Wrapped("recovery"),0);
        SaveAccountIdentity Signed(AccountIdentityBackup value)=>new(value.Identity,value.PasswordBackup,value.RecoveryBackup,Convert.ToBase64String(key.SignData(AccountIdentityPolicy.BackupStatement(userId,value),HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation)),value.Revision);
        using(var r=await Request(null,HttpMethod.Get,"/account/identity"))Check(r.StatusCode==HttpStatusCode.Unauthorized,"anonymous backup access denied");
        using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity",Signed(backup) with{Signature=Convert.ToBase64String(new byte[64])}))Check(r.StatusCode==HttpStatusCode.BadRequest,"invalid root ownership signature rejected");
        var replies=await Task.WhenAll(Enumerable.Range(0,6).Select(async _=>{using var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity",Signed(backup));return r.StatusCode;}));
        Check(replies.Count(code=>code==HttpStatusCode.OK)==1&&replies.Count(code=>code==HttpStatusCode.Conflict)==5,"parallel initialization commits exactly one account root");
        using(var r=await Request("bob-hybrid",HttpMethod.Get,"/account/identity")){
            var saved=(await r.Content.ReadFromJsonAsync<AccountIdentityBackup>())!;
            Check(saved.Revision==1&&saved.Identity==identity,"owner restores the same root and encrypted backups");Check(r.Headers.CacheControl?.NoStore==true,"private backups are never cacheable");backup=saved;
        }
        using(var r=await Request("alice-hybrid",HttpMethod.Get,"/account/identity"))Check((await r.Content.ReadAsStringAsync()) is "" or "null","another account cannot read private root backups");
        var replay=Signed(backup with{Revision=0});using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity",replay))Check(r.StatusCode==HttpStatusCode.Conflict,"old signed backup revisions cannot roll back recovery");
        using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity",Signed(backup)))Check(r.StatusCode==HttpStatusCode.OK,"root owner can rotate the encrypted password wrapper");
        var changedIdentity=backup with{Identity=identity with{SourceDeviceId="different-source"},Revision=2};
        using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity",Signed(changedIdentity)))Check(r.StatusCode==HttpStatusCode.Conflict,"established root endorsement remains immutable");
        var certificate=new AccountDeviceCertificate(1,coords,deviceId,coords,hybrid,"");
        certificate=certificate with{Signature=Convert.ToBase64String(key.SignData(AccountIdentityPolicy.DeviceStatement(userId,certificate),HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation))};
        using(var r=await Request("alice-hybrid",HttpMethod.Post,"/account/identity/device",certificate))Check(r.StatusCode==HttpStatusCode.BadRequest,"foreign account cannot certify another device");
        using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity/device",certificate with{HybridKey=Convert.ToBase64String(new byte[64])}))Check(r.StatusCode==HttpStatusCode.BadRequest,"hybrid identity substitution rejected");
        using(var r=await Request("bob-hybrid",HttpMethod.Post,"/account/identity/device",certificate))Check(r.StatusCode==HttpStatusCode.NoContent,"root signature authorizes the current legacy and hybrid device identities");
        await using(var scope=app.Services.CreateAsyncScope()){
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();Check(await db.AccountIdentities.CountAsync(x=>x.UserId==userId)==1,"database preserves one root across concurrent enrollments");
            Check(AccountIdentityPolicy.Certificate(await db.Devices.SingleAsync(x=>x.Id==deviceId))==certificate,"certificate survives persistence without private keys");
        }
        Console.WriteLine($"PASS {count} PostgreSQL account identity recovery checks");
    }
}
