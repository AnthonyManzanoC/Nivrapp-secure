using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    public static void MapDeviceContinuityEndpoints(this WebApplication app)
    {
        app.MapPost("/devices/{deviceId}/authorize-live",async (string deviceId,DeviceContinuityRequest request,HttpContext http,NivraDbContext db,IHubContext<NivraHub> hub,TimeProvider time,CancellationToken ct)=>
        {
            var current=http.GetCurrentUser();if(current==null)return Results.Unauthorized();
            var devices=await db.Devices.Where(device=>device.UserId==current.UserId&&device.IsTrusted&&device.RevokedAt==null&&
                (device.Id==current.DeviceId||device.Id==deviceId)).ToListAsync(ct);
            var source=devices.Find(device=>device.Id==current.DeviceId);var target=devices.Find(device=>device.Id==deviceId);
            if(source==null||target==null||source.Id==target.Id)return Results.NotFound();
            if(!DeviceContinuityPolicy.Apply(source,target,request))return Error("invalid_device_authorization","El código no corresponde a la llave de este equipo.",400);
            db.SecurityAuditEvents.Add(new SecurityAuditEvent
            {
                Id=NivraIds.NewId("aud"),UserId=current.UserId,Action="device.live_authorized",
                IpAddress=ClientIp(http),Details=$"Source={source.Id}; Device={target.Id}",CreatedAt=time.GetUtcNow()
            });
            await db.SaveChangesAsync(ct);
            await NotifyUsers(hub,[current.UserId],"device.listChanged",new {deviceId,liveAuthorized=true});
            return Results.NoContent();
        }).RequireRateLimiting("auth");
    }
}
