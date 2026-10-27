namespace Nivra.Api.Services;

public sealed class WebRtcOptions
{
    public bool RelayOnly { get; set; }
    public List<WebRtcIceServerOptions> IceServers { get; set; } = [];
    public bool HasConfiguredRelay => IceServers.Any(server => !string.IsNullOrWhiteSpace(server.Username) &&
        !string.IsNullOrWhiteSpace(server.Credential) && server.Urls.Any(url =>
            Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "turn" or "turns" &&
            url.Trim().Length > uri.Scheme.Length + 1));
}

public sealed class WebRtcIceServerOptions
{
    public List<string> Urls { get; set; } = [];
    public string? Username { get; set; }
    public string? Credential { get; set; }
}

public sealed record WebRtcIceServerResponse(
    List<string> Urls,
    string? Username,
    string? Credential);

public sealed record WebRtcIceConfigResponse(
    List<WebRtcIceServerResponse> IceServers,
    bool RelayOnly);
