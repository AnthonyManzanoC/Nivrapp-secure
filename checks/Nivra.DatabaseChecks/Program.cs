using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;
using Npgsql;

// Explicit opt-in tool: no application host, users, messages or production calls are created.
if (!args.Contains("--check") && !args.Contains("--migrate")) { Console.WriteLine("Use --check (read/locks) or --migrate (apply pending migrations). Run from repository root."); return; }
try
{
    var configurationPath = File.Exists("Nivra.Api/appsettings.Development.json") ? "Nivra.Api/appsettings.Development.json" : "Nivra.Api/appsettings.json";
    using var configuration = JsonDocument.Parse(await File.ReadAllTextAsync(configurationPath));
    var rawConnection = Environment.GetEnvironmentVariable("ConnectionStrings__Supabase") ?? configuration.RootElement.GetProperty("ConnectionStrings").GetProperty("Supabase").GetString()!;
    var connection = PostgresConnection.ToNpgsqlConnectionString(rawConnection);
    var options = new DbContextOptionsBuilder<NivraDbContext>().UseNpgsql(connection, provider => provider.EnableRetryOnFailure(3)).Options;
    await using var db = new NivraDbContext(options);
    var pending = (await db.Database.GetPendingMigrationsAsync()).ToArray();
    Console.WriteLine("Database connected; pending migrations: " + string.Join(", ", pending));
    if (args.Contains("--migrate")) { await db.Database.MigrateAsync(); Console.WriteLine("Migrations applied successfully."); }
    var lockKey = "nivra-regression:" + Guid.NewGuid().ToString("N");
    var inside = 0; var peak = 0;
    var checks = Enumerable.Range(0, 8).Select(async _ =>
    {
        await using var participantDb = new NivraDbContext(options);
        await CallCoordination.RunAsync(participantDb, async () =>
        {
            await using var transaction = await CallCoordination.LockAsync(participantDb, lockKey, CancellationToken.None);
            var concurrency = Interlocked.Increment(ref inside);
            Interlocked.Exchange(ref peak, Math.Max(peak, concurrency));
            await Task.Delay(30);
            Interlocked.Decrement(ref inside);
            await transaction.CommitAsync();
            return true;
        });
    });
    await Task.WhenAll(checks);
    if (peak != 1) throw new InvalidOperationException("PostgreSQL coordination failed.");
    Console.WriteLine("PASS: eight real PostgreSQL transactions serialize under the call advisory lock.");
    if (!(await db.Database.GetPendingMigrationsAsync()).Any())
    {
        var malformed = await db.Users.CountAsync(user => user.NivraNumber.Length != 9);
        if (malformed != 0) throw new InvalidOperationException("Invalid account identifier backfill.");
        Console.WriteLine("PASS: account ID backfill, ownership and recovery schema are current.");
    }
}
catch (Exception error)
{
    // Never print database connection strings, host credentials, SQL parameters or account data.
    Console.Error.WriteLine("Database check failed: " + error.GetType().Name + (error is PostgresException pg ? " SQLSTATE=" + pg.SqlState : ""));
    Environment.ExitCode = 1;
}
