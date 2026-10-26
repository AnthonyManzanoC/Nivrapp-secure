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

    // Encrypted PCM mono 22.05 kHz, fifteen seconds, WAV header and GCM tag.
    // The server validates ownership/size, never the title or private waveform.
    public static bool CanAttachMusic(FileObject? file, string ownerUserId, DateTimeOffset now) =>
        CanAttach(file, ownerUserId, now) && file!.EncryptedSize <= 15 * 22050 * 2 + 44 + 16;

    public static string? FileId(StoryRecord story, string? track) => track == "music" ? story.MusicFileObjectId : track is null ? story.MediaFileObjectId : null;

    public static DateTimeOffset Deadline(DateTimeOffset requested, DateTimeOffset? mediaExpiry) =>
        mediaExpiry is { } expiresAt && expiresAt < requested ? expiresAt : requested;

    public static DateTimeOffset Deadline(DateTimeOffset requested, DateTimeOffset? mediaExpiry, DateTimeOffset? musicExpiry) =>
        Deadline(Deadline(requested, mediaExpiry), musicExpiry);
}
