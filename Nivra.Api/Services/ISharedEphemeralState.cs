namespace Nivra.Api.Services;

// All operations must fail closed when the configured shared store is unavailable.
public interface ISharedEphemeralState
{
    string? Read(string key);
    void Write(string key, string value, TimeSpan lifetime);
    bool CompareExchange(string key, string expected, string replacement, TimeSpan lifetime);
    bool TryTake(string key, string expected);
    void Remove(string key);
    Task<IDisposable?> AcquireLeaseAsync(string key, TimeSpan lifetime, CancellationToken cancellationToken);
}
