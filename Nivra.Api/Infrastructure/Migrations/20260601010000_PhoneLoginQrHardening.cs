using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Infrastructure;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations;

[DbContext(typeof(NivraDbContext))]
[Migration("20260601010000_PhoneLoginQrHardening")]
public partial class PhoneLoginQrHardening : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_users_Phone",
            schema: "public",
            table: "users");

        migrationBuilder.AddColumn<bool>(
            name: "RequiresAlias",
            schema: "public",
            table: "users",
            type: "boolean",
            nullable: false,
            defaultValue: false);

        migrationBuilder.CreateIndex(
            name: "IX_users_Phone",
            schema: "public",
            table: "users",
            column: "Phone",
            unique: true,
            filter: "\"Phone\" IS NOT NULL AND \"DisabledAt\" IS NULL");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_users_Phone",
            schema: "public",
            table: "users");

        migrationBuilder.DropColumn(
            name: "RequiresAlias",
            schema: "public",
            table: "users");

        migrationBuilder.CreateIndex(
            name: "IX_users_Phone",
            schema: "public",
            table: "users",
            column: "Phone");
    }
}
