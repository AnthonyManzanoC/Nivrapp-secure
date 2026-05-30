using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Nivra.Api.Infrastructure;

public sealed class NivraDbContextFactory : IDesignTimeDbContextFactory<NivraDbContext>
{
    public NivraDbContext CreateDbContext(string[] args)
    {
        var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Development";
        var configuration = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile($"appsettings.{environment}.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        var rawConnectionString = configuration.GetConnectionString("Supabase")
            ?? throw new InvalidOperationException("ConnectionStrings:Supabase is required for EF Core design time.");

        var options = new DbContextOptionsBuilder<NivraDbContext>()
            .UseNpgsql(
                PostgresConnection.ToNpgsqlConnectionString(rawConnectionString),
                npgsql => npgsql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery))
            .Options;

        return new NivraDbContext(options);
    }
}
