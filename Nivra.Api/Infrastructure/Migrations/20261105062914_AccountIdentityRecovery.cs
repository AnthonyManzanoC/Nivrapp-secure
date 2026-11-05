using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AccountIdentityRecovery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AccountCertificateJson",
                schema: "public",
                table: "devices",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "account_identities",
                schema: "public",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PublicJson = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: false),
                    PasswordBackup = table.Column<string>(type: "character varying(16384)", maxLength: 16384, nullable: false),
                    RecoveryBackup = table.Column<string>(type: "character varying(16384)", maxLength: 16384, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_account_identities", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_account_identities_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "account_identities",
                schema: "public");

            migrationBuilder.DropColumn(
                name: "AccountCertificateJson",
                schema: "public",
                table: "devices");
        }
    }
}
