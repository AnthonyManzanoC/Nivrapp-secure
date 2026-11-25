using Microsoft.EntityFrameworkCore;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public static class ChatReceiptCleanup
{
    // Keep ciphertext and receipt rows on the server. This operation changes only
    // visibility, and preserves the first deletion timestamp for recovery feeds.
    public static async Task MarkDeletedAsync(NivraDbContext db, string conversationId, string? userId, DateTimeOffset now, CancellationToken ct)
    {
        if (db.Database.IsNpgsql())
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE public.message_receipts r SET deleted_at = {now} FROM public.messages m WHERE r.message_id = m.\"Id\" AND m.\"ConversationId\" = {conversationId} AND r.deleted_at IS NULL AND ({userId}::text IS NULL OR r.user_id = {userId})", ct);
            return;
        }

        var messages = await db.Messages.Where(message => message.ConversationId == conversationId).ToListAsync(ct);
        foreach (var receipt in messages.SelectMany(message => message.Receipts).Where(receipt => userId is null || receipt.UserId == userId))
            receipt.DeletedAt ??= now;
    }
}
