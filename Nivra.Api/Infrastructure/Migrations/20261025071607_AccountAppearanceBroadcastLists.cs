using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AccountAppearanceBroadcastLists : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "account_appearances",
                schema: "public",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Icon = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_account_appearances", x => x.UserId);
                    table.CheckConstraint("CK_account_appearances_Icon", "\"Icon\" IN ('original','emerald','ivory')");
                    table.ForeignKey(
                        name: "FK_account_appearances_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "broadcast_lists",
                schema: "public",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    EncryptedPayload = table.Column<string>(type: "character varying(1048576)", maxLength: 1048576, nullable: true),
                    RecipientCount = table.Column<int>(type: "integer", nullable: false),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_broadcast_lists", x => new { x.UserId, x.Id });
                    table.CheckConstraint("CK_broadcast_lists_RecipientCount", "\"RecipientCount\" BETWEEN 0 AND 256");
                    table.ForeignKey(
                        name: "FK_broadcast_lists_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_broadcast_lists_UserId_DeletedAt_UpdatedAt",
                schema: "public",
                table: "broadcast_lists",
                columns: new[] { "UserId", "DeletedAt", "UpdatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "account_appearances",
                schema: "public");

            migrationBuilder.DropTable(
                name: "broadcast_lists",
                schema: "public");
        }
    }
}
