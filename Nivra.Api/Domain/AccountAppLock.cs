namespace Nivra.Api.Domain;

// A client-created verifier, never the PIN or biometric templates. This is an
// application privacy lock; it does not replace account/session authentication.
public sealed class AccountAppLock
{
    public string UserId { get; set; } = "";
    public long Revision { get; set; }
    public bool Enabled { get; set; }
    public string? PinEnvelopeJson { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
