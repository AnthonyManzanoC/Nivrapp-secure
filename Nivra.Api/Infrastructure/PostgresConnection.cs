using Npgsql;

namespace Nivra.Api.Infrastructure;

public static class PostgresConnection
{
    public static string ToNpgsqlConnectionString(string rawConnectionString)
    {
        NpgsqlConnectionStringBuilder builder;
        if (rawConnectionString.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase) ||
            rawConnectionString.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase))
        {
            var uri = new Uri(rawConnectionString);
            var userInfo = uri.UserInfo.Split(':', 2);
            builder = new NpgsqlConnectionStringBuilder
            {
                Host = uri.Host,
                Port = uri.Port > 0 ? uri.Port : 5432,
                Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
                Username = Uri.UnescapeDataString(userInfo[0]),
                Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty,
            };
            foreach (var parameter in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = parameter.Split('=', 2);
                var name = Uri.UnescapeDataString(pair[0]).Replace('_', ' ');
                name = name.ToLowerInvariant() switch
                {
                    "connect timeout" => "Timeout",
                    "max pool size" => "Maximum Pool Size",
                    "min pool size" => "Minimum Pool Size",
                    _ => name
                };
                builder[name] = Uri.UnescapeDataString(pair.Length > 1 ? pair[1] : string.Empty);
            }
        }
        else
        {
            builder = new NpgsqlConnectionStringBuilder(rawConnectionString);
        }

        // A session pooler dedicates one remote slot to each local socket. Two
        // services plus a rolling deployment must fit the common 15-slot tier.
        // Explicit capacity budgets are respected instead of overwritten by 200.
        var supabasePooler = builder.Host?.EndsWith(".pooler.supabase.com", StringComparison.OrdinalIgnoreCase) == true;
        SetDefault(builder, "Maximum Pool Size", supabasePooler && builder.Port == 5432 ? 3 : 20);
        SetDefault(builder, "Minimum Pool Size", 0);
        SetDefault(builder, "Pooling", true);
        SetDefault(builder, "Timeout", 10);
        SetDefault(builder, "Command Timeout", 20);
        SetDefault(builder, "Connection Idle Lifetime", 30);
        SetDefault(builder, "Connection Pruning Interval", 5);
        if (builder.SslMode is SslMode.Disable or SslMode.Allow or SslMode.Prefer)
            builder.SslMode = SslMode.Require;
        if (supabasePooler && builder.Port == 6543) builder.MaxAutoPrepare = 0;
        builder.IncludeErrorDetail = false;
        return builder.ConnectionString;
    }

    private static void SetDefault(NpgsqlConnectionStringBuilder builder, string name, object value)
    {
        if (!builder.ShouldSerialize(name)) builder[name] = value;
    }
}
