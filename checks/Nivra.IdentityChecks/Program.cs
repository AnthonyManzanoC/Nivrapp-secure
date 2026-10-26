using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Operations;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Infrastructure.Migrations;

var count = 0;
void Check(bool condition, string label)
{
    if (!condition) throw new InvalidOperationException(label);
    Console.WriteLine($"PASS {label}");
    count++;
}

var aliases = Enumerable.Range(0, 512).Select(_ => PrivateAccountAliases.Generate()).ToList();
Check(aliases.All(alias => Regex.IsMatch(alias, "^[a-z]+-[a-z]+-[0-9]{4}$")),
    "private aliases contain two readable words and four ASCII digits");
Check(aliases.All(alias => alias.Length is >= 3 and <= 32 && NivraNumbers.NormalizeAlias(alias) == alias),
    "generated aliases fit the existing normalized login and profile contract");
Check(aliases.All(alias => NivraNumbers.Normalize(alias) is null),
    "private aliases cannot collide with the nine-digit login namespace");
var previousCulture = CultureInfo.CurrentCulture;
try
{
    CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("ar-SA");
    Check(Regex.IsMatch(PrivateAccountAliases.Generate(), "^[a-z]+-[a-z]+-[0-9]{4}$"),
        "alias generation keeps ASCII digits regardless of server culture");
}
finally { CultureInfo.CurrentCulture = previousCulture; }

var checkedAliases = new List<string>();
var available = await PrivateAccountAliases.GenerateAvailableAsync((candidate, _) =>
{
    checkedAliases.Add(candidate);
    return Task.FromResult(checkedAliases.Count <= 3);
});
Check(checkedAliases.Count == 4 && available == checkedAliases[3],
    "allocation skips existing aliases and returns only a checked free candidate");
var checks = 0;
var exhausted = await PrivateAccountAliases.GenerateAvailableAsync((_, _) =>
{
    checks++;
    return Task.FromResult(true);
});
Check(exhausted is null && checks == PrivateAccountAliases.MaxAllocationAttempts,
    "an unavailable namespace fails after bounded attempts instead of looping forever");

using var cancellation = new CancellationTokenSource();
cancellation.Cancel();
var invokedWhenCancelled = false;
var cancelled = false;
try
{
    await PrivateAccountAliases.GenerateAvailableAsync((_, _) =>
    {
        invokedWhenCancelled = true;
        return Task.FromResult(false);
    }, cancellation.Token);
}
catch (OperationCanceledException) { cancelled = true; }
Check(cancelled && !invokedWhenCancelled, "cancelled registrations perform no availability lookup");
using var lookupCancellation = new CancellationTokenSource();
cancelled = false;
try
{
    await PrivateAccountAliases.GenerateAvailableAsync((_, token) =>
    {
        Check(token == lookupCancellation.Token, "availability lookups receive the request cancellation token");
        lookupCancellation.Cancel();
        return Task.FromResult(false);
    }, lookupCancellation.Token);
}
catch (OperationCanceledException) { cancelled = true; }
Check(cancelled, "a candidate is not returned after cancellation during its lookup");
var lookupFailed = false;
try
{
    await PrivateAccountAliases.GenerateAvailableAsync((_, _) => throw new InvalidOperationException("test database unavailable"));
}
catch (InvalidOperationException) { lookupFailed = true; }
Check(lookupFailed, "lookup failures cannot be treated as an available alias");

var user = new UserAccount
{
    Id = "usr_unchanged", NivraNumber = "123456789", Alias = "n_0123456789abcdef01234567",
    PasswordHash = new PasswordHash(), IsDiscoverable = false
};
Check(!user.IsPrivateAccount, "a hidden or technical-looking ordinary account is not automatically private");
user.IsPrivateAccount = true;
var identity = user.Id;
var number = user.NivraNumber;
var passwordHash = user.PasswordHash;
user.Alias = "custom-name";
user.DisplayName = "Nombre elegido";
user.Phone = "+570000000000";
user.Email = "test@example.invalid";
user.IsDiscoverable = true;
Check(user.IsPrivateAccount && user.Id == identity && user.NivraNumber == number && ReferenceEquals(user.PasswordHash, passwordHash),
    "profile customization preserves private origin, login number and credential ownership");
Check(typeof(PatchProfileRequest).GetProperty(nameof(UserAccount.IsPrivateAccount)) is null,
    "profile requests cannot claim or remove private-account registration mode");
var webJson = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var responses = new object[]
{
    new UserResponse(user.Id, user.Alias, user.DisplayName, null, null, null, null, false, true, "free", PrivacySettings.Default(), default, user.NivraNumber, true),
    new ContactResponse(user.Id, user.Alias, null, null, null, null, false, false, default, user.NivraNumber, true),
    new UserSummaryResponse(user.Id, user.Alias, null, null, null, null, false, true, false, false, false, "none", user.NivraNumber, true),
    new ParticipantResponse(user.Id, ParticipantRole.Member, false, false, default, null, null, true)
};
Check(responses.All(response => JsonSerializer.SerializeToElement(response, response.GetType(), webJson).GetProperty("isPrivateAccount").GetBoolean()),
    "account, contact, summary and participant responses expose the same explicit private flag");

// No connection is opened: inspect Npgsql model, SQL translation and migration operations.
var options = new DbContextOptionsBuilder<NivraDbContext>()
    .UseNpgsql("Host=localhost;Database=unused;Username=unused;Password=unused").Options;
using var db = new NivraDbContext(options);
var model = db.Model.FindEntityType(typeof(UserAccount))!;
var flag = model.FindProperty(nameof(UserAccount.IsPrivateAccount))!;
Check(flag.ClrType == typeof(bool) && !flag.IsNullable && Equals(flag.GetDefaultValue(), false),
    "private registration mode is persisted as a nonnullable opt-in boolean");
Check(model.GetIndexes().Any(index => index.IsUnique && index.Properties.Select(property => property.Name).SequenceEqual([nameof(UserAccount.Alias)])),
    "the existing alias unique index remains the final concurrent-allocation guard");
var aliasLookup = db.Users.Where(account => account.Alias == "bruma-lunar-4827").Select(account => account.Id).ToQueryString();
Check(aliasLookup.Contains("\"Alias\"") && !aliasLookup.Contains("DisabledAt"),
    "availability lookup includes disabled accounts that still reserve their alias");
var projection = db.Users.Select(account => new { account.Id, account.NivraNumber, account.IsPrivateAccount }).ToQueryString();
Check(projection.Contains("\"IsPrivateAccount\"") && projection.Contains("\"NivraNumber\""),
    "Npgsql translates the stable private classification alongside the original login number");
var migration = new PrivateAccountIdentity();
var up = migration.UpOperations;
Check(up.Count == 2 && up[0] is AddColumnOperation { Name: "IsPrivateAccount", Table: "users", Schema: "public", IsNullable: false, DefaultValue: false },
    "migration adds only the default-false classification column before backfill");
var backfill = ((SqlOperation)up[1]).Sql;
Check(backfill.Contains("'^n_[0-9a-f]{24}$'") && backfill.Contains("audit.\"UserId\" = account.\"Id\"")
    && backfill.Contains("audit.\"Action\" = 'auth.register_private'") && backfill.Contains("EXISTS"),
    "legacy classification requires both the exact generated alias and the same account's registration audit");
Check(Regex.Matches(backfill, "SET\\s+\"[^\"]+\"", RegexOptions.IgnoreCase).Select(match => match.Value.Trim()).SequenceEqual(["SET \"IsPrivateAccount\""])
    && !Regex.IsMatch(backfill, "\\b(DELETE|INSERT|DROP|ALTER)\\b", RegexOptions.IgnoreCase),
    "backfill never rewrites aliases, IDs, profile data or cryptographic material");
Check(migration.DownOperations.Count == 1 && migration.DownOperations[0] is DropColumnOperation { Name: "IsPrivateAccount", Table: "users" },
    "rollback removes only the new classification column");
var migrations = db.GetService<IMigrationsAssembly>();
Check(migrations.Migrations.Keys.Any(key => key.EndsWith("_PrivateAccountIdentity", StringComparison.Ordinal))
    && string.CompareOrdinal(migrations.Migrations.Keys.Single(key => key.EndsWith("_PrivateAccountIdentity", StringComparison.Ordinal)),
        migrations.Migrations.Keys.Single(key => key.EndsWith("_AccountAppLock", StringComparison.Ordinal))) > 0,
    "private identity migration is discoverable after the released app-lock schema");
Check(!db.Database.HasPendingModelChanges(), "migration snapshot matches the current EF model without connecting to a database");
Console.WriteLine($"Completed {count} identity checks (offline; no database connection).");
