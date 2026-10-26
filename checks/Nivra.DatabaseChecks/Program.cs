using System.Text.Json;
using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
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
    var metadataProbe = "__metadata_probe__" + Guid.NewGuid().ToString("N");
    var relationshipLock = typeof(EndpointExtensions).GetMethod("LockRelationshipAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
    Task<IDbContextTransaction> MetadataLock(NivraDbContext context, string scope) =>
        (Task<IDbContextTransaction>)relationshipLock.Invoke(null, [context, scope, metadataProbe, CancellationToken.None])!;
    // Exercise the exact released failure against the real provider, with only
    // a random advisory lock. This starts no account/session or message write.
    var rejectedUnscopedTransaction = false;
    try
    {
        await using var unexpected = await MetadataLock(db, "account-appearance");
        // Raw advisory-lock SQL intentionally bypasses provider retries. The
        // first ordinary LINQ query inside that transaction triggers the guard.
        await db.Set<AccountAppearance>().AsNoTracking().SingleOrDefaultAsync(row => row.UserId == metadataProbe);
    }
    catch (InvalidOperationException error) when (error.Message.Contains("user-initiated transactions", StringComparison.OrdinalIgnoreCase)) { rejectedUnscopedTransaction = true; }
    if (!rejectedUnscopedTransaction || db.Database.CurrentTransaction is not null)
        throw new InvalidOperationException("Metadata transaction regression did not reproduce or release its failed transaction.");
    Console.WriteLine("PASS: real Npgsql reproduces the old appearance transaction failure and rolls back its advisory-lock attempt.");
    foreach (var scope in new[] { "account-appearance", "account-broadcast-lists", "relationship-probe" })
    {
        await CallCoordination.RunAsync(db, async () =>
        {
            await using var transaction = await MetadataLock(db, scope);
            // Reserved random fixture IDs only: real account data is neither
            // selected nor written. Missing schema/translation errors surface.
            if (await db.Set<AccountAppearance>().AsNoTracking().SingleOrDefaultAsync(row => row.UserId == metadataProbe) is not null ||
                (await db.Set<BroadcastListRecord>().AsNoTracking().Where(row => row.UserId == metadataProbe)
                    .OrderBy(row => row.DeletedAt != null).ThenByDescending(row => row.UpdatedAt).ThenBy(row => row.Id).Take(200).ToListAsync()).Count != 0)
                throw new InvalidOperationException("Unexpected metadata probe collision.");
            var deviceQuery = (IQueryable<DeviceRecord>)typeof(EndpointExtensions).GetMethod("MetadataDeviceQuery", BindingFlags.Static | BindingFlags.NonPublic)!
                .Invoke(null, [db, metadataProbe, metadataProbe])!;
            if (await deviceQuery.FirstOrDefaultAsync() is not null) throw new InvalidOperationException("Unexpected device probe collision.");
            await transaction.CommitAsync();
            return true;
        });
    }
    Console.WriteLine("PASS: real PostgreSQL appearance, broadcast and relationship locks run with provider retries; metadata GET and trusted-device queries execute (no rows changed).");
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
    // Exercise a read/modify/write JSON snapshot with independent real DB sessions and
    // the exact per-story scope used by view/react/comment. No story or user is written.
    var storyKey = "story:regression:" + Guid.NewGuid().ToString("N");
    var jsonSnapshot = JsonSerializer.Serialize(new Dictionary<string, List<string>> { ["views"] = [], ["reactions"] = [], ["comments"] = [] });
    await Task.WhenAll(Enumerable.Range(0, 8).Select(async index =>
    {
        await using var participantDb = new NivraDbContext(options);
        await CallCoordination.RunAsync(participantDb, async () =>
        {
            await using var transaction = await CallCoordination.LockAsync(participantDb, storyKey, CancellationToken.None);
            var snapshot = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(jsonSnapshot)!;
            await Task.Delay(10); // A concurrent JSON snapshot without the lock loses updates here.
            snapshot["views"].Add("viewer-fixture-" + index);
            snapshot[index % 2 == 0 ? "reactions" : "comments"].Add("activity-fixture-" + index);
            jsonSnapshot = JsonSerializer.Serialize(snapshot);
            await transaction.CommitAsync();
            return true;
        });
    }));
    var finalSnapshot = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(jsonSnapshot)!;
    if (finalSnapshot["views"].Count != 8 || finalSnapshot["reactions"].Count != 4 || finalSnapshot["comments"].Count != 4)
        throw new InvalidOperationException("Concurrent story activity snapshots lost updates.");
    Console.WriteLine("PASS: eight real PostgreSQL locks preserve every local JSON activity snapshot (no production stories written).");
    // Every contender can hold the same still-valid setup token before waiting. The
    // account's RequiresAlias state must be read after the per-user PostgreSQL lock.
    var aliasKey = "phone-alias:regression:" + Guid.NewGuid().ToString("N");
    var requiresAlias = true;
    var issuedAliasSessions = 0;
    await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
    {
        await using var participantDb = new NivraDbContext(options);
        await CallCoordination.RunAsync(participantDb, async () =>
        {
            await using var transaction = await CallCoordination.LockAsync(participantDb, aliasKey, CancellationToken.None);
            var accountRequiresAlias = requiresAlias;
            await Task.Delay(10);
            if (accountRequiresAlias)
            {
                requiresAlias = false;
                Interlocked.Increment(ref issuedAliasSessions);
            }
            await transaction.CommitAsync();
            return true;
        });
    }));
    if (requiresAlias || issuedAliasSessions != 1) throw new InvalidOperationException("Concurrent alias completion issued duplicate sessions.");
    Console.WriteLine("PASS: eight real PostgreSQL locks recheck alias state and allow one fixture session (no production accounts written).");
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
