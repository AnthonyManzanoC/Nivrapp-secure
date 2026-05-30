using Npgsql;

namespace Nivra.Api.Infrastructure;

public static class PostgresConnection
{
    public static string ToNpgsqlConnectionString(string rawConnectionString)
    {
        if (rawConnectionString.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase) ||
            rawConnectionString.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase))
        {
            var uri = new Uri(rawConnectionString);
            var userInfo = uri.UserInfo.Split(':', 2);
            var builder = new NpgsqlConnectionStringBuilder
            {
                Host = uri.Host,
                Port = uri.Port > 0 ? uri.Port : 5432,
                Database = uri.AbsolutePath.TrimStart('/'),
                Username = Uri.UnescapeDataString(userInfo[0]),
                Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty,
                SslMode = SslMode.Require,
                Pooling = true,
                Timeout = 15,
                CommandTimeout = 30,
                IncludeErrorDetail = false
            };

            return builder.ConnectionString;
        }

        var npgsqlBuilder = new NpgsqlConnectionStringBuilder(rawConnectionString)
        {
            SslMode = SslMode.Require
        };
        return npgsqlBuilder.ConnectionString;
    }
}
