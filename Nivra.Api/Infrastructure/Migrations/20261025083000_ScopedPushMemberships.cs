using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nivra.Api.Infrastructure.Migrations;

/// <summary>A physical push address may belong to both saved account/device scopes.</summary>
[DbContext(typeof(NivraDbContext))]
[Migration("20261025083000_ScopedPushMemberships")]
public sealed class ScopedPushMemberships : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(name: "IX_push_tokens_TokenHash", schema: "public", table: "push_tokens");
        migrationBuilder.CreateIndex(name: "IX_push_tokens_UserId_DeviceId_TokenHash", schema: "public", table: "push_tokens",
            columns: new[] { "UserId", "DeviceId", "TokenHash" }, unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Downgrading is allowed only after the operator resolves shared addresses.
        // PostgreSQL's unique-index validation deliberately fails without deleting data.
        migrationBuilder.CreateIndex(name: "IX_push_tokens_TokenHash", schema: "public", table: "push_tokens",
            column: "TokenHash", unique: true);
        migrationBuilder.DropIndex(name: "IX_push_tokens_UserId_DeviceId_TokenHash", schema: "public", table: "push_tokens");
    }
}
