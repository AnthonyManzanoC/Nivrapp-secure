using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class PrivateAccountNumbers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "NivraNumber",
                schema: "public",
                table: "users",
                type: "character varying(9)",
                maxLength: 9,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MediaEncryption",
                schema: "public",
                table: "calls",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_users_NivraNumber",
                schema: "public",
                table: "users",
                column: "NivraNumber",
                unique: true);

            // Install uniqueness before assigning existing accounts. Retry collisions
            // individually; never derive a public number from the phone or creation order.
            migrationBuilder.Sql("""
                DO $$
                DECLARE account_id text; candidate text; attempts integer;
                BEGIN
                  FOR account_id IN SELECT "Id" FROM public.users WHERE "NivraNumber" IS NULL LOOP
                    attempts := 0;
                    LOOP
                      attempts := attempts + 1;
                      IF attempts > 128 THEN RAISE EXCEPTION 'Unable to allocate a unique Nivra ID'; END IF;
                      candidate := ((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 900000000) + 100000000)::text;
                      IF EXISTS (SELECT 1 FROM public.users WHERE "Alias" = candidate) THEN CONTINUE; END IF;
                      BEGIN
                        UPDATE public.users SET "NivraNumber" = candidate WHERE "Id" = account_id AND "NivraNumber" IS NULL;
                        EXIT;
                      EXCEPTION WHEN unique_violation THEN
                        -- The unique index remains the final authority, even on collision.
                        NULL;
                      END;
                    END LOOP;
                  END LOOP;
                END $$;
                """);

            migrationBuilder.AlterColumn<string>(
                name: "NivraNumber", schema: "public", table: "users",
                type: "character varying(9)", maxLength: 9, nullable: false,
                defaultValueSql: "((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 900000000) + 100000000)::text",
                oldClrType: typeof(string), oldType: "character varying(9)", oldMaxLength: 9, oldNullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_users_NivraNumber",
                schema: "public",
                table: "users",
                sql: "\"NivraNumber\" ~ '^[1-9][0-9]{8}$'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_users_NivraNumber",
                schema: "public",
                table: "users");

            migrationBuilder.DropCheckConstraint(
                name: "CK_users_NivraNumber",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "NivraNumber",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "MediaEncryption",
                schema: "public",
                table: "calls");
        }
    }
}
