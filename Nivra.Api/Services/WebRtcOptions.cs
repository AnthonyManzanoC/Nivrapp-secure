namespace Nivra.Api.Services;

public sealed class WebRtcOptions
{
    public bool RelayOnly { get; set; }
    public List<WebRtcIceServerOptions> IceServers { get; set; } = [];
    public bool HasConfiguredRelay => PublicIceServers().Any(server => !string.IsNullOrWhiteSpace(server.Username) &&
        !string.IsNullOrWhiteSpace(server.Credential) && server.Urls.Any(url =>
            Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "turn" or "turns" &&
            url.Trim().Length > uri.Scheme.Length + 1));
    public List<WebRtcIceServerResponse> PublicIceServers()
    {
        var servers = (IceServers ?? []).Where(server => server is not null).Select(server => new WebRtcIceServerResponse(
            (server.Urls ?? []).Select(url => url?.Trim() ?? "").Where(url => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "stun" or "stuns" or "turn" or "turns" && url.Length > uri.Scheme.Length + 1)
                .Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList(),
            string.IsNullOrWhiteSpace(server.Username) ? null : server.Username.Trim(), string.IsNullOrWhiteSpace(server.Credential) ? null : server.Credential.Trim()))
            .Where(server => server.Urls.Count > 0).Take(8).ToList();
        if (servers.Count == 0) servers.Add(new(["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"], null, null));
        return servers;
    }
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
