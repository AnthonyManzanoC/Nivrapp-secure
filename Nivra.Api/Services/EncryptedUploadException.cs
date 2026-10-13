namespace Nivra.Api.Services;

// Deliberately carries a public code, never a storage provider response or credentials.
public sealed class EncryptedUploadException(string code) : IOException(code)
{
    public string Code { get; } = code;
}
