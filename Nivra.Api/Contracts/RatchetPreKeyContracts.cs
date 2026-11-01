using System.Text.Json.Serialization;

namespace Nivra.Api.Contracts;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record RatchetPublicBundle(
    int V, string Suite, int RegistrationId, int DeviceId, string IdentityKey,
    uint PreKeyId, string PreKeyPublic, uint SignedPreKeyId, string SignedPreKeyPublic,
    string SignedPreKeySignature, uint KyberPreKeyId, string KyberPreKeyPublic, string KyberPreKeySignature);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record RatchetPublishRequest(List<RatchetPublicBundle> Bundles);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record RatchetReserveRequest(string ConversationId, Guid RequestId);

public sealed record RatchetPreKeyReservation(string DeviceId, Guid RequestId, RatchetPublicBundle Bundle);
