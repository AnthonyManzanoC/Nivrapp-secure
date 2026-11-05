using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;
using System.Text.Json;

namespace Nivra.Api.Endpoints;
public static partial class EndpointExtensions
{
    public static void MapAccountIdentityEndpoints(this WebApplication app)
    {
        var routes=app.MapGroup("/account/identity").RequireRateLimiting("auth");
        routes.MapGet("/",async Task<IResult>(HttpContext http,NivraDbContext db,CancellationToken ct)=>{
            var user=http.GetCurrentUser();if(user is null)return Results.Unauthorized();
            http.Response.Headers.CacheControl="no-store";
            var record=await db.AccountIdentities.AsNoTracking().SingleOrDefaultAsync(x=>x.UserId==user.UserId,ct);
            return Results.Ok(record is null?null:new AccountIdentityBackup(AccountIdentityPolicy.Read(record)!,record.PasswordBackup,record.RecoveryBackup,record.Revision));
        });
        routes.MapPost("/",async Task<IResult>(SaveAccountIdentity request,HttpContext http,NivraDbContext db,TimeProvider clock,CancellationToken ct)=>{
            var user=http.GetCurrentUser();if(user is null)return Results.Unauthorized();
            var root=request.Identity;
            if(root is null||root.V!=1||root.RootKey?.Length!=87||root.SourceDeviceId?.Length is not (>0 and <=128)||root.SourceHybrid?.Length!=88||root.SourceLegacy?.Length!=87||root.Endorsement?.Length!=88
                ||!AccountIdentityPolicy.ValidBackup(request.PasswordBackup,"password")||!AccountIdentityPolicy.ValidBackup(request.RecoveryBackup,"recovery"))return Results.BadRequest();
            if(request.Revision<0||request.Revision>=int.MaxValue)return Results.BadRequest();
            var backup=new AccountIdentityBackup(root,request.PasswordBackup,request.RecoveryBackup,request.Revision);
            if(!AccountIdentityPolicy.Verify(root.RootKey,AccountIdentityPolicy.BackupStatement(user.UserId,backup),request.Signature))return Results.BadRequest();
            return await CallCoordination.RunAsync(db,async()=>{
                await using var tx=await CallCoordination.LockAsync(db,"account-identity:"+user.UserId,ct);
                var record=await db.AccountIdentities.SingleOrDefaultAsync(x=>x.UserId==user.UserId,ct);
                if(record is null){
                    if(request.Revision!=0)return Results.Conflict();
                    var device=await db.Devices.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==user.DeviceId&&x.UserId==user.UserId&&x.RevokedAt==null&&x.IsTrusted,ct);
                    var hybrid=await db.Set<RatchetPilotDevice>().AsNoTracking().SingleOrDefaultAsync(x=>x.DeviceId==user.DeviceId&&x.UserId==user.UserId&&x.AddressMode==2,ct);
                    if(device is null||hybrid is null||root.SourceDeviceId!=device.Id||root.SourceLegacy!=DeviceContinuityPolicy.Coordinates(device.KeyBundle.IdentityKey)||root.SourceHybrid!=hybrid.IdentityKey)return Results.BadRequest();
                    record=new AccountIdentityRecord{UserId=user.UserId,PublicJson=JsonSerializer.Serialize(root,AccountIdentityPolicy.Json),PasswordBackup=request.PasswordBackup,RecoveryBackup=request.RecoveryBackup,CreatedAt=clock.GetUtcNow()};db.AccountIdentities.Add(record);
                }else{
                    // A password reset or a new device cannot replace the established account identity.
                    if(record.PublicJson!=JsonSerializer.Serialize(root,AccountIdentityPolicy.Json)||record.Revision!=request.Revision)return Results.Conflict();
                    record.PasswordBackup=request.PasswordBackup;record.RecoveryBackup=request.RecoveryBackup;
                    record.Revision++;
                }
                await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);http.Response.Headers.CacheControl="no-store";return Results.Ok(backup with {Revision=record.Revision});
            });
        });
        routes.MapPost("/device",async Task<IResult>(AccountDeviceCertificate certificate,HttpContext http,NivraDbContext db,CancellationToken ct)=>{
            var user=http.GetCurrentUser();if(user is null)return Results.Unauthorized();
            if(certificate.V!=1||certificate.DeviceId!=user.DeviceId)return Results.BadRequest();
            return await CallCoordination.RunAsync(db,async()=>{
                await using var tx=await CallCoordination.LockAsync(db,"account-identity:"+user.UserId,ct);
                var root=AccountIdentityPolicy.Read(await db.AccountIdentities.SingleOrDefaultAsync(x=>x.UserId==user.UserId,ct));
                var device=await db.Devices.SingleOrDefaultAsync(x=>x.Id==user.DeviceId&&x.UserId==user.UserId&&x.RevokedAt==null&&x.IsTrusted,ct);
                var hybrid=await db.Set<RatchetPilotDevice>().AsNoTracking().SingleOrDefaultAsync(x=>x.DeviceId==user.DeviceId&&x.UserId==user.UserId&&x.AddressMode==2,ct);
                if(root is null||device is null||hybrid is null||root.RootKey!=certificate.RootKey||hybrid.IdentityKey!=certificate.HybridKey||DeviceContinuityPolicy.Coordinates(device.KeyBundle.IdentityKey)!=certificate.LegacyKey
                    ||!AccountIdentityPolicy.Verify(root.RootKey,AccountIdentityPolicy.DeviceStatement(user.UserId,certificate),certificate.Signature))return Results.BadRequest();
                device.AccountCertificateJson=JsonSerializer.Serialize(certificate,AccountIdentityPolicy.Json);await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);return Results.NoContent();
            });
        });
    }
}
