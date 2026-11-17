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
using Nivra.Api.Security;
using Nivra.Api.Services;

public static class MultiDeviceLoginChecks
{
    public static async Task Run(WebApplication app,IReadOnlyDictionary<string,string> otherTokens)
    {
        var count=0;
        void Check(bool value,string label){if(!value)throw new InvalidOperationException(label);count++;Console.WriteLine("PASS real multi-device login "+label);}
        using var client=new HttpClient {BaseAddress=new Uri(app.Urls.Single()),Timeout=TimeSpan.FromSeconds(45)};
        const string alias="multi-login-lab",password="Synthetic-login-password-10";
        var names=new[]{"APK one","APK two","Web","EXE"};
        var hardware=new[]{"multi-hardware-apk-one","multi-hardware-apk-two","multi-hardware-web","multi-hardware-exe"};
        string B64Url(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
        string PublicKey()
        {
            using var key=ECDsa.Create(ECCurve.NamedCurves.nistP256);var point=key.ExportParameters(false).Q;
            return JsonSerializer.Serialize(new{kty="EC",crv="P-256",x=B64Url(point.X!),y=B64Url(point.Y!)});
        }
        var bundles=Enumerable.Range(0,4).Select(_=>new KeyBundleRequest(PublicKey(),null,null,[])).ToArray();
        async Task<HttpResponseMessage> Request(HttpMethod method,string path,object? body=null,string? token=null)
        {
            using var request=new HttpRequestMessage(method,path);
            if(body is not null)request.Content=JsonContent.Create(body);
            if(token is not null)request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
            return await client.SendAsync(request);
        }
        AuthResponse registered;
        using(var response=await Request(HttpMethod.Post,"/auth/register",new RegisterRequest(alias,password,names[0],bundles[0],null,null,null,hardware[0])))
        {
            Check(response.StatusCode==HttpStatusCode.Created,"account registration uses the production HTTP endpoint and a real password hash");
            registered=(await response.Content.ReadFromJsonAsync<AuthResponse>())!;
        }
        var sessions=await Task.WhenAll(Enumerable.Range(0,4).Select(async index=>
        {
            using var response=await Request(HttpMethod.Post,"/auth/login",new LoginRequest(alias,password,names[index],bundles[index],hardware[index]));
            if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("Simultaneous production login failed with "+(int)response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<AuthResponse>())!;
        }));
        Check(sessions.Select(session=>session.User.Id).Distinct().Single()==registered.User.Id&&sessions.Select(session=>session.Device.Id).Distinct().Count()==4,
            "simultaneous 2 APK plus Web and EXE logins create four independent addresses on one account");
        Check(sessions[0].Device.Id==registered.Device.Id&&sessions.Select(session=>session.Device.HardwareId).ToHashSet().SetEquals(hardware),
            "the original APK identity is retained while the other hardware identities remain distinct");
        Check(sessions.Select(session=>session.Tokens.AccessToken).Distinct().Count()==4&&sessions.Select(session=>session.Tokens.RefreshToken).Distinct().Count()==4,
            "each actual login issues an independent access and refresh credential pair");
        async Task Devices(AuthResponse session,int expected)
        {
            using var response=await Request(HttpMethod.Get,"/devices",token:session.Tokens.AccessToken);
            if(response.StatusCode!=HttpStatusCode.OK||(await response.Content.ReadFromJsonAsync<List<DeviceResponse>>())?.Count!=expected)
                throw new InvalidOperationException("A linked login lost its own account's device list.");
        }
        await Task.WhenAll(sessions.Select(session=>Devices(session,4)));
        await Devices(registered,4);
        Check(true,"all four authenticated clients and the pre-existing APK session remain usable after simultaneous login");
        var refreshed=await Task.WhenAll(sessions.Select(async session=>
        {
            using var response=await Request(HttpMethod.Post,"/auth/refresh",new RefreshTokenRequest(session.Tokens.RefreshToken));
            if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("An independent device refresh failed.");
            return (await response.Content.ReadFromJsonAsync<TokenPair>())!;
        }));
        for(var index=0;index<4;index++)sessions[index]=sessions[index] with{Tokens=refreshed[index]};
        await Task.WhenAll(sessions.Select(session=>Devices(session,4)));
        Check(true,"simultaneous refreshes rotate only their own sessions without invalidating other devices");
        using(var invalid=await Request(HttpMethod.Post,"/auth/login",new LoginRequest(alias,"incorrect-password",names[0],bundles[0],"intruder-hardware")))
            Check(invalid.StatusCode==HttpStatusCode.Unauthorized,"an incorrect password cannot create an additional trusted device");
        await Devices(sessions[0],4);
        using(var foreign=await Request(HttpMethod.Post,$"/devices/{sessions[0].Device.Id}/revoke",new{},otherTokens["stranger"]))
            Check(foreign.StatusCode==HttpStatusCode.NotFound,"an authenticated foreign account cannot revoke a linked device");

        // The root record is an independently persisted encrypted account backup.
        // Generate a real P-256 secret and the exact PBKDF2/HKDF + AES-GCM wrappers
        // used by the clients; bootstrap endorsement trust is tested separately.
        using var rootKey=ECDsa.Create(ECCurve.NamedCurves.nistP256);var rootParams=rootKey.ExportParameters(true);
        var root=B64Url(rootParams.Q.X!)+":"+B64Url(rootParams.Q.Y!);
        var entropy=RandomNumberGenerator.GetBytes(32);
        var secret=JsonSerializer.SerializeToUtf8Bytes(new {v=1,userId=registered.User.Id,rootKey=root,
            privateJwk=new{kty="EC",crv="P-256",x=B64Url(rootParams.Q.X!),y=B64Url(rootParams.Q.Y!),d=B64Url(rootParams.D!),ext=true,key_ops=new[]{"sign"}},
            recoveryEntropy=Convert.ToBase64String(entropy)},AccountIdentityPolicy.Json);
        string Wrap(string method)
        {
            var salt=RandomNumberGenerator.GetBytes(32);var iv=RandomNumberGenerator.GetBytes(12);
            var key=method=="password"?Rfc2898DeriveBytes.Pbkdf2(password,salt,600000,HashAlgorithmName.SHA256,32):HKDF.DeriveKey(HashAlgorithmName.SHA256,entropy,32,salt,Encoding.UTF8.GetBytes("nivra-account-recovery-v1"));
            var ciphertext=new byte[secret.Length];var tag=new byte[16];
            var aad=JsonSerializer.SerializeToUtf8Bytes(new[]{"nivra-account-secret-v1",registered.User.Id,root,method},AccountIdentityPolicy.Json);
            using(var cipher=new AesGcm(key,16))cipher.Encrypt(iv,secret,ciphertext,tag,aad);
            CryptographicOperations.ZeroMemory(key);
            return JsonSerializer.Serialize(new{v=1,method,salt=Convert.ToBase64String(salt),iv=Convert.ToBase64String(iv),ciphertext=Convert.ToBase64String([..ciphertext,..tag]),iterations=method=="password"?600000:0},AccountIdentityPolicy.Json);
        }
        var passwordBackup=Wrap("password");var recoveryBackup=Wrap("recovery");
        var rootPublic=new AccountRootPublic(1,root,registered.Device.Id,Convert.ToBase64String(RandomNumberGenerator.GetBytes(64)),DeviceContinuityPolicy.Coordinates(bundles[0].IdentityKey)!,Convert.ToBase64String(new byte[64]));
        await using(var scope=app.Services.CreateAsyncScope())
        {
            var db=scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            db.AccountIdentities.Add(new(){UserId=registered.User.Id,PublicJson=JsonSerializer.Serialize(rootPublic,AccountIdentityPolicy.Json),PasswordBackup=passwordBackup,RecoveryBackup=recoveryBackup,CreatedAt=DateTimeOffset.UtcNow});
            await db.SaveChangesAsync();
        }
        foreach(var session in sessions.Take(3))
        {
            using var revoke=await Request(HttpMethod.Post,$"/devices/{session.Device.Id}/revoke",new{},sessions[3].Tokens.AccessToken);
            Check(revoke.StatusCode==HttpStatusCode.NoContent,"a real revocation endpoint removes one former linked device");
        }
        using(var revoke=await Request(HttpMethod.Post,$"/devices/{sessions[3].Device.Id}/revoke",new{},sessions[3].Tokens.AccessToken))
            Check(revoke.StatusCode==HttpStatusCode.NoContent,"the last authenticated device can be revoked without deleting the account root");
        foreach(var session in sessions)
        {
            using var denied=await Request(HttpMethod.Get,"/account/identity",token:session.Tokens.AccessToken);
            using var refresh=await Request(HttpMethod.Post,"/auth/refresh",new RefreshTokenRequest(session.Tokens.RefreshToken));
            if(denied.StatusCode!=HttpStatusCode.Unauthorized||refresh.StatusCode!=HttpStatusCode.Unauthorized)throw new InvalidOperationException("A revoked login retained access or refresh permission.");
        }
        Check(true,"all four former access tokens and refresh tokens immediately lose private backup access after total revocation");
        AuthResponse recovered;
        using(var response=await Request(HttpMethod.Post,"/auth/login",new LoginRequest(alias,password,"Web after total removal",new(PublicKey(),null,null,[]),hardware[2])))
        {
            Check(response.StatusCode==HttpStatusCode.OK,"a fresh real login succeeds after every former device was revoked");
            recovered=(await response.Content.ReadFromJsonAsync<AuthResponse>())!;
        }
        Check(recovered.User.Id==registered.User.Id&&sessions.All(session=>session.Device.Id!=recovered.Device.Id),
            "re-entry retains the same account while assigning a fresh device address even on reused hardware");
        using(var response=await Request(HttpMethod.Get,"/devices/authority",token:recovered.Tokens.AccessToken))
        {
            var authority=await response.Content.ReadFromJsonAsync<DeviceAuthorityResponse>();
            Check(response.StatusCode==HttpStatusCode.OK&&authority?.PrimaryDeviceId==recovered.Device.Id&&authority.Devices.Count==1,
                "the only new authenticated device automatically becomes primary without an orphaned account");
        }
        using(var response=await Request(HttpMethod.Get,"/account/identity",token:recovered.Tokens.AccessToken))
        {
            var backup=await response.Content.ReadFromJsonAsync<AccountIdentityBackup>();
            Check(response.StatusCode==HttpStatusCode.OK&&backup?.Identity.RootKey==root&&backup.PasswordBackup==passwordBackup&&backup.RecoveryBackup==recoveryBackup,
                "total device revocation preserves the established root and both encrypted recovery wrappers byte-for-byte");
            using var envelope=JsonDocument.Parse(backup!.PasswordBackup);var node=envelope.RootElement;
            var key=Rfc2898DeriveBytes.Pbkdf2(password,Convert.FromBase64String(node.GetProperty("salt").GetString()!),600000,HashAlgorithmName.SHA256,32);
            var encrypted=Convert.FromBase64String(node.GetProperty("ciphertext").GetString()!);var plain=new byte[encrypted.Length-16];
            var aad=JsonSerializer.SerializeToUtf8Bytes(new[]{"nivra-account-secret-v1",recovered.User.Id,root,"password"},AccountIdentityPolicy.Json);
            using(var cipher=new AesGcm(key,16))cipher.Decrypt(Convert.FromBase64String(node.GetProperty("iv").GetString()!),encrypted.AsSpan(0,plain.Length),encrypted.AsSpan(plain.Length),plain,aad);
            Check(CryptographicOperations.FixedTimeEquals(plain,secret),"the fresh login actually decrypts the same recoverable root secret with its password");
            CryptographicOperations.ZeroMemory(key);CryptographicOperations.ZeroMemory(plain);
        }
        using(var response=await Request(HttpMethod.Get,"/account/identity",token:otherTokens["stranger"]))
            Check(response.StatusCode==HttpStatusCode.OK&&!(await response.Content.ReadAsStringAsync()).Contains(root,StringComparison.Ordinal),
                "a foreign account never receives the recovered root backup");
        CryptographicOperations.ZeroMemory(secret);CryptographicOperations.ZeroMemory(entropy);
        Console.WriteLine($"PASS {count} real HTTP multi-device login, refresh, revocation and root recovery checks");
    }
}
