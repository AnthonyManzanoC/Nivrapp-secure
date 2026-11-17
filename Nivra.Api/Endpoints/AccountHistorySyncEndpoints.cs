using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public sealed record AccountHistoryEnvelope(int V, string RootKey, string MessageId, string ClientMessageId, string ConversationId,
    string SenderUserId, string SenderDeviceId, string At, string Iv, string Ciphertext, string Signature);
public sealed record AccountHistoryUpload(List<AccountHistoryEnvelope>? Messages);

public static partial class EndpointExtensions
{
    public static byte[] AccountHistoryStatement(string userId, AccountHistoryEnvelope row) => JsonSerializer.SerializeToUtf8Bytes(new object[] {
        "nivra-account-history-signature-v1", userId, row.RootKey, row.MessageId, row.ClientMessageId, row.ConversationId,
        row.SenderUserId, row.SenderDeviceId, row.At, row.Iv, row.Ciphertext }, AccountIdentityPolicy.Json);

    public static bool ValidAccountHistoryEnvelope(string userId, string root, AccountHistoryEnvelope? row)
    {
        if (row is null || row.V != 1 || row.RootKey != root || row.MessageId?.Length is not (>0 and <=64) ||
            new[] {row.MessageId,row.ConversationId,row.SenderUserId,row.SenderDeviceId}.Any(value => value is null || value.Length is <1 or >128 || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_' && c != '-')) ||
            string.IsNullOrWhiteSpace(row.ClientMessageId)||row.ClientMessageId.Length>128||
            row.At?.Length != 24 || !DateTimeOffset.TryParseExact(row.At,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out _) ||
            row.Iv?.Length != 16 || row.Ciphertext?.Length is not (>20 and <=1400000) || row.Signature?.Length != 88) return false;
        try {
            var iv=Convert.FromBase64String(row.Iv); var cipher=Convert.FromBase64String(row.Ciphertext);
            if(iv.Length!=12||cipher.Length is <17 or >1048592||Convert.ToBase64String(iv)!=row.Iv||Convert.ToBase64String(cipher)!=row.Ciphertext)return false;
        } catch(FormatException){return false;}
        return AccountIdentityPolicy.Verify(root,AccountHistoryStatement(userId,row),row.Signature);
    }

    public static void MapAccountHistorySyncEndpoints(this WebApplication app)
    {
        var routes=app.MapGroup("/account/history-sync").RequireRateLimiting("auth");
        routes.MapPost("/",async Task<IResult>(AccountHistoryUpload request,HttpContext http,NivraDbContext db,TimeProvider clock,IConfiguration configuration,CancellationToken ct)=>{
            var current=http.GetCurrentUser();if(current is null)return Results.Unauthorized();
            http.Response.Headers.CacheControl="no-store";
            if(request.Messages is null||request.Messages.Count is <1 or >8||request.Messages.Select(row=>row?.MessageId).Distinct().Count()!=request.Messages.Count)return Results.BadRequest();
            var root=AccountIdentityPolicy.Read(await db.AccountIdentities.AsNoTracking().SingleOrDefaultAsync(row=>row.UserId==current.UserId,ct));
            if(root is null)return Results.Conflict(new{code="account_identity_required"});
            if(request.Messages.Any(row=>!ValidAccountHistoryEnvelope(current.UserId,root.RootKey,row)))return Results.BadRequest(new{code="invalid_history_signature"});
            var ids=request.Messages.Select(row=>row.MessageId).ToList();
            // Serialize writers per account so concurrent phones cannot replace or duplicate an archive entry.
            return await CallCoordination.RunAsync(db,async()=>{
                await using var tx=await CallCoordination.LockAsync(db,"account-history:"+current.UserId,ct);
                var permitted=await MessageHistoryRecoveryQuery(db.Messages.AsNoTracking(),db.Conversations.AsNoTracking(),current.UserId,ids).ToListAsync(ct);
                var now=clock.GetUtcNow();var accepted=new List<string>();
                var budget=Math.Clamp(configuration.GetValue<long?>("HistorySync:MaxBytesPerAccount")??134217728,1048576,1073741824);
                var used=await db.Set<AccountHistorySyncItem>().Where(item=>item.UserId==current.UserId).SumAsync(item=>(long?)item.EnvelopeJson.Length,ct)??0;
                foreach(var row in request.Messages){
                    var message=permitted.Find(message=>message.Id==row.MessageId);
                    if(message is null||!HistoryMayBeArchived(message,current.UserId,now)||message.ConversationId!=row.ConversationId||message.SenderUserId!=row.SenderUserId||message.SenderDeviceId!=row.SenderDeviceId||
                        message.ClientMessageId!=row.ClientMessageId||message.ServerReceivedAt.ToUnixTimeMilliseconds()!=DateTimeOffset.Parse(row.At,CultureInfo.InvariantCulture).ToUnixTimeMilliseconds())continue;
                    if(!await db.Set<AccountHistorySyncItem>().AnyAsync(item=>item.UserId==current.UserId&&item.MessageId==row.MessageId,ct)){
                        var envelope=JsonSerializer.Serialize(row,AccountIdentityPolicy.Json);
                        if(used+envelope.Length>budget)return Results.Json(new{code="history_archive_storage_limit"},statusCode:507);
                        used+=envelope.Length;
                        db.Set<AccountHistorySyncItem>().Add(new AccountHistorySyncItem{UserId=current.UserId,MessageId=row.MessageId,RootKey=root.RootKey,EnvelopeJson=envelope,CreatedAt=now});
                    }
                    accepted.Add(row.MessageId);
                }
                await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);return Results.Ok(new{accepted});
            });
        });
        routes.MapGet("/",async Task<IResult>(string? after,HttpContext http,NivraDbContext db,TimeProvider clock,CancellationToken ct)=>{
            var current=http.GetCurrentUser();if(current is null)return Results.Unauthorized();
            http.Response.Headers.CacheControl="no-store";
            if(!long.TryParse(after??"0",NumberStyles.None,CultureInfo.InvariantCulture,out var cursor)||cursor<0)return Results.BadRequest();
            var root=AccountIdentityPolicy.Read(await db.AccountIdentities.AsNoTracking().SingleOrDefaultAsync(row=>row.UserId==current.UserId,ct));
            if(root is null)return Results.Conflict(new{code="account_identity_required"});
            var rows=await db.Set<AccountHistorySyncItem>().AsNoTracking().Where(row=>row.UserId==current.UserId&&row.RootKey==root.RootKey&&row.Id>cursor).OrderBy(row=>row.Id).Take(9).ToListAsync(ct);
            var page=rows.Take(8).ToList();var ids=page.Select(row=>row.MessageId).ToList();
            var allowed=await MessageHistoryRecoveryQuery(db.Messages.AsNoTracking(),db.Conversations.AsNoTracking(),current.UserId,ids).ToListAsync(ct);
            var now=clock.GetUtcNow();var permitted=allowed.Where(row=>HistoryMayBeArchived(row,current.UserId,now)).Select(row=>row.Id).ToHashSet(StringComparer.Ordinal);
            // Bounded pruning of expired/deleted content, including rows already behind this device's cursor.
            var stale=await db.Set<AccountHistorySyncItem>().Where(row=>row.UserId==current.UserId&&db.Messages.Any(message=>message.Id==row.MessageId&&
                (message.DeleteAfterRead||message.ExpiresAt!=null&&message.ExpiresAt<=now||message.Receipts.Any(receipt=>receipt.UserId==current.UserId&&receipt.DeletedAt!=null))))
                .OrderBy(row=>row.Id).Select(row=>row.Id).Take(64).ToListAsync(ct);
            if(stale.Count>0)await db.Set<AccountHistorySyncItem>().Where(row=>row.UserId==current.UserId&&stale.Contains(row.Id)).ExecuteDeleteAsync(ct);
            return Results.Ok(new{messages=page.Where(row=>permitted.Contains(row.MessageId)).Select(row=>JsonSerializer.Deserialize<AccountHistoryEnvelope>(row.EnvelopeJson,AccountIdentityPolicy.Json)),
                next=page.Count==0?cursor.ToString(CultureInfo.InvariantCulture):page[^1].Id.ToString(CultureInfo.InvariantCulture),hasMore=rows.Count>8});
        });
    }
    private static bool HistoryMayBeArchived(MessageEnvelope message,string userId,DateTimeOffset now)=>!message.DeleteAfterRead&&
        (message.ExpiresAt is null||message.ExpiresAt>now)&&!message.Receipts.Any(receipt=>receipt.UserId==userId&&receipt.DeletedAt is not null);
}
