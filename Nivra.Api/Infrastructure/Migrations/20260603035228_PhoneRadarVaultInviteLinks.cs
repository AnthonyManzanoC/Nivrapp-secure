using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class PhoneRadarVaultInviteLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PhoneHash",
                schema: "public",
                table: "users",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "vault_room_invites",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    VaultRoomId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedByUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CodeHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    RequireApproval = table.Column<bool>(type: "boolean", nullable: false),
                    MaxUses = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    Uses = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_room_invites", x => x.Id);
                    table.ForeignKey(
                        name: "FK_vault_room_invites_users_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_vault_room_invites_vault_rooms_VaultRoomId",
                        column: x => x.VaultRoomId,
                        principalSchema: "public",
                        principalTable: "vault_rooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_users_PhoneHash",
                schema: "public",
                table: "users",
                column: "PhoneHash",
                unique: true,
                filter: "\"PhoneHash\" IS NOT NULL AND \"DisabledAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_vault_room_invites_CodeHash",
                schema: "public",
                table: "vault_room_invites",
                column: "CodeHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_vault_room_invites_CreatedByUserId",
                schema: "public",
                table: "vault_room_invites",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_vault_room_invites_VaultRoomId_ExpiresAt",
                schema: "public",
                table: "vault_room_invites",
                columns: new[] { "VaultRoomId", "ExpiresAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "vault_room_invites",
                schema: "public");

            migrationBuilder.DropIndex(
                name: "IX_users_PhoneHash",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "PhoneHash",
                schema: "public",
                table: "users");
        }
    }
}
