using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class NativePushRegistrationPolicy
{
    public static bool CanRenewDestination(PushTokenRecord? destination, string userId, string deviceId) =>
        destination is null || (destination.UserId == userId && destination.DeviceId == deviceId &&
            destination.RevokedAt is null && string.Equals(destination.Provider, "fcm", StringComparison.OrdinalIgnoreCase));

    public static bool IsAllowed(SessionRecord? session, UserAccount? user, DeviceRecord? device,
        string requestedUserId, string requestedDeviceId, DateTimeOffset now) =>
        session is { RevokedAt: null } && session.ExpiresAt > now &&
        user is { DisabledAt: null } && device is { RevokedAt: null, IsTrusted: true } &&
        session.UserId == requestedUserId && session.DeviceId == requestedDeviceId &&
        user.Id == session.UserId && device.Id == session.DeviceId && device.UserId == session.UserId;
}
