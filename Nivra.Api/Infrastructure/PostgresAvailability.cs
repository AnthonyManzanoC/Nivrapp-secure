using Npgsql;

namespace Nivra.Api.Infrastructure;

public static class PostgresAvailability
{
    public static bool IsUnavailable(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is PostgresException postgres &&
                (postgres.SqlState is PostgresErrorCodes.TooManyConnections or PostgresErrorCodes.CannotConnectNow ||
                 postgres.SqlState == "XX000" &&
                 (postgres.MessageText.Contains("EMAXCONNSESSION", StringComparison.OrdinalIgnoreCase) ||
                  postgres.MessageText.Contains("max clients reached", StringComparison.OrdinalIgnoreCase)))) return true;
            if (current is NpgsqlException { IsTransient: true }) return true;
        }
        return false;
    }
}
