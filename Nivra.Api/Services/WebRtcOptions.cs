namespace Nivra.Api.Services;

public sealed class WebRtcOptions
{
    public bool RelayOnly { get; set; }
    public List<WebRtcIceServerOptions> IceServers { get; set; } = [];
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
