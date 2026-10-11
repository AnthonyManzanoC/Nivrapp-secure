using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace Nivra.Api.Security;

public static class TrustedProxyConfiguration
{
    public static ForwardedHeadersOptions? Read(IConfiguration configuration)
    {
        if (!configuration.GetValue<bool>("ReverseProxy:Enabled")) return null;
        var options = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            ForwardLimit = Math.Clamp(configuration.GetValue<int?>("ReverseProxy:ForwardLimit") ?? 1, 1, 4)
        };
        // Clear the implicit loopback trust; production trusts only operator-specified hops.
        options.KnownProxies.Clear();
        options.KnownNetworks.Clear();
        foreach (var item in configuration.GetSection("ReverseProxy:KnownProxies").Get<string[]>() ?? [])
        {
            if (!IPAddress.TryParse(item, out var address)) throw new InvalidOperationException("Invalid trusted proxy address.");
            options.KnownProxies.Add(address);
        }
        foreach (var item in configuration.GetSection("ReverseProxy:KnownNetworks").Get<string[]>() ?? [])
        {
            var pieces = item.Split('/');
            if (pieces.Length != 2 || !IPAddress.TryParse(pieces[0], out var address) || !int.TryParse(pieces[1], out var prefix) ||
                prefix <= 0 || prefix > (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 128))
                throw new InvalidOperationException("Invalid trusted proxy CIDR network. Trusting every network is forbidden.");
            options.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(address, prefix));
        }
        if (options.KnownProxies.Count == 0 && options.KnownNetworks.Count == 0)
            throw new InvalidOperationException("Forwarded headers require an explicit trusted proxy or network list.");
        return options;
    }
}
