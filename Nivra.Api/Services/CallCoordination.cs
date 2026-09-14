using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

/// <summary>Serializes call ownership across API processes, including same-device browser tabs.</summary>
public static class CallCoordination
{
    public static Task<T> RunAsync<T>(NivraDbContext db, Func<Task<T>> operation) =>
        new CallTransactionExecutionStrategy(db).ExecuteAsync(operation);

    // The application enables provider retries. Enter an EF execution-strategy scope before starting
    // our transaction, but never replay a call mutation after an uncertain commit or emitted event.
    // A failed request is reconciled against the persisted call before the client tries again.
    private sealed class CallTransactionExecutionStrategy(NivraDbContext db) : ExecutionStrategy(db, 0, TimeSpan.Zero)
    {
        protected override bool ShouldRetryOn(Exception exception) => false;
    }

    public static async Task<IDbContextTransaction> LockAsync(NivraDbContext db, string key, CancellationToken cancellationToken)
    {
        var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            // Transaction-scoped PostgreSQL locks are shared by every API instance and released on rollback.
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT pg_advisory_xact_lock(hashtextextended({key}, 0))", cancellationToken);
            return transaction;
        }
        catch
        {
            await transaction.DisposeAsync();
            throw;
        }
    }

    public static bool IsValidSessionId(string? sessionId) => sessionId is null ||
        (sessionId.Length is > 0 and <= 128 && sessionId.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.'));

    public static bool IsOwner(CallSession call, string userId, string deviceId, string? sessionId) =>
        call.ParticipantSessions.TryGetValue(userId, out var owner) &&
        owner.DeviceId == deviceId && owner.ClientSessionId == sessionId;

    public static bool TryClaim(CallSession call, string userId, string deviceId, string? sessionId)
    {
        if (!call.ParticipantUserIds.Contains(userId) || call.EndedAt is not null || call.Status == CallStatus.Ended || !IsValidSessionId(sessionId))
        {
            return false;
        }
        if (call.ParticipantSessions.ContainsKey(userId))
        {
            return IsOwner(call, userId, deviceId, sessionId);
        }
        call.ParticipantSessions[userId] = new CallParticipantSession(deviceId, sessionId);
        return true;
    }

    // Only used by the explicit "Continue here" endpoint; normal answer races must never replace an owner.
    public static bool TryResume(CallSession call, string userId, string deviceId, string? sessionId)
    {
        if (!call.ParticipantUserIds.Contains(userId) || call.EndedAt is not null || call.Status == CallStatus.Ended || !IsValidSessionId(sessionId)) return false;
        call.ParticipantSessions[userId] = new CallParticipantSession(deviceId, sessionId);
        return true;
    }

    public static bool IsCurrentSignalSource(CallSession call, CallSignalRecord signal)
    {
        if (call.ParticipantSessions.TryGetValue(signal.FromUserId, out var owner))
        {
            return owner.DeviceId == signal.FromDeviceId && owner.ClientSessionId == signal.FromClientSessionId;
        }
        // A departed participant's final control may still be delivered, but their old SDP/ICE cannot revive a peer.
        return signal.SignalType is "left" or "declined" or "busy";
    }

    public static Task<CallSession?> FindActiveGroupCallAsync(NivraDbContext db, string conversationId, CancellationToken cancellationToken) =>
        db.Calls.Where(call => call.ConversationId == conversationId && call.EndedAt == null && call.Status != CallStatus.Ended)
            .OrderByDescending(call => call.StartedAt).FirstOrDefaultAsync(cancellationToken);

    public static bool TryAuthorizeSignal(CallSession call, string userId, string deviceId, string? sessionId, string signalType)
    {
        if (signalType is "declined" or "busy")
        {
            return !call.ParticipantSessions.ContainsKey(userId) || IsOwner(call, userId, deviceId, sessionId);
        }
        return signalType == "accepted"
            ? TryClaim(call, userId, deviceId, sessionId)
            : IsOwner(call, userId, deviceId, sessionId);
    }

    public static bool TryLeave(CallSession call, string userId, string deviceId, string? sessionId, bool isGroup, DateTimeOffset now)
    {
        if (!TryClaim(call, userId, deviceId, sessionId)) return false;
        call.ParticipantSessions.Remove(userId);
        if (!isGroup || call.ParticipantSessions.Count == 0)
        {
            call.Status = CallStatus.Ended;
            call.EndedAt = now;
            call.ParticipantSessions.Clear();
        }
        return true;
    }

    public static bool ShouldIgnoreTimeout(CallSession call, string userId) =>
        call.Status == CallStatus.Active || call.ParticipantSessions.Keys.Any(participant => participant != userId);
}
