using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    public partial class PrivateAccountIdentity : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsPrivateAccount",
                schema: "public",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            // The old generated alias alone is not proof of registration mode.
            // Preserve customized aliases and unproven accounts conservatively.
            // This changes only the classification; login IDs and key ownership stay intact.
            migrationBuilder.Sql("""
                UPDATE public.users AS account
                SET "IsPrivateAccount" = TRUE
                WHERE account."IsPrivateAccount" = FALSE
                  AND account."Alias" ~ '^n_[0-9a-f]{24}$'
                  AND EXISTS (
                      SELECT 1
                      FROM public.security_audit_events AS audit
                      WHERE audit."UserId" = account."Id"
                        AND audit."Action" = 'auth.register_private'
                  );
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IsPrivateAccount",
                schema: "public",
                table: "users");
        }
    }
}
