using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class StoryMediaPolicy
{
    public const int MaxEncryptedPayloadChars = 5 * 1024 * 1024;
    public const int MaxCaptionChars = 500;

    public static bool ValidPayload(string? encryptedPayload, string? caption = null) =>
        !string.IsNullOrWhiteSpace(encryptedPayload) && encryptedPayload.Length <= MaxEncryptedPayloadChars &&
        (caption is null || caption.Length <= MaxCaptionChars);

    public static bool CanRepost(StoryRecord story, bool authorAllowsReposts) =>
        !story.ViewOnce && story.AllowReposts && authorAllowsReposts;

    public static bool CanAttach(FileObject? file, string ownerUserId, DateTimeOffset now) =>
        file is { State: FileState.Uploaded, EncryptedSize: > 0, VaultRoomId: null } &&
        file.OwnerUserId == ownerUserId && (file.ExpiresAt is null || file.ExpiresAt > now);

    public static DateTimeOffset Deadline(DateTimeOffset requested, DateTimeOffset? mediaExpiry) =>
        mediaExpiry is { } expiresAt && expiresAt < requested ? expiresAt : requested;
}
