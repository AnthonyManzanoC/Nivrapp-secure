using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class UserContactHashesBlindSync : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DO $$
                BEGIN
                    CREATE EXTENSION IF NOT EXISTS pgcrypto;

                    UPDATE public.users
                    SET "PhoneHash" = lower(encode(digest('nivra-phone:v1:' || "Phone", 'sha256'), 'hex'))
                    WHERE "Phone" IS NOT NULL
                        AND "PhoneHash" IS NULL
                        AND "DisabledAt" IS NULL;
                EXCEPTION
                    WHEN insufficient_privilege OR undefined_file OR undefined_function THEN
                        RAISE NOTICE 'Skipping Nivra phone hash backfill because pgcrypto is not available.';
                END $$;
                """);

            migrationBuilder.CreateTable(
                name: "user_contact_hashes",
                schema: "public",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ContactPhoneHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_contact_hashes", x => new { x.UserId, x.ContactPhoneHash });
                    table.ForeignKey(
                        name: "FK_user_contact_hashes_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_user_contact_hashes_ContactPhoneHash",
                schema: "public",
                table: "user_contact_hashes",
                column: "ContactPhoneHash");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_contact_hashes",
                schema: "public");
        }
    }
}
