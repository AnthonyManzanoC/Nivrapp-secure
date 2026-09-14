using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AccountRecoveryEmail : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "RecoveryEmail",
                schema: "public",
                table: "users",
                type: "character varying(320)",
                maxLength: 320,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RecoveryEmailVerifiedAt",
                schema: "public",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "account_recovery_challenges",
                schema: "public",
                columns: table => new
                {
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Purpose = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ConsumedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_account_recovery_challenges", x => x.TokenHash);
                    table.ForeignKey(
                        name: "FK_account_recovery_challenges_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_account_recovery_challenges_ExpiresAt",
                schema: "public",
                table: "account_recovery_challenges",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_account_recovery_challenges_UserId_Purpose_CreatedAt",
                schema: "public",
                table: "account_recovery_challenges",
                columns: new[] { "UserId", "Purpose", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "account_recovery_challenges",
                schema: "public");

            migrationBuilder.DropColumn(
                name: "RecoveryEmail",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "RecoveryEmailVerifiedAt",
                schema: "public",
                table: "users");
        }
    }
}
