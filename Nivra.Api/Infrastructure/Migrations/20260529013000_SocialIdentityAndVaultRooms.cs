using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260529013000_SocialIdentityAndVaultRooms")]
    public partial class SocialIdentityAndVaultRooms : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Bio",
                schema: "public",
                table: "users",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsDiscoverable",
                schema: "public",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<string>(
                name: "ProfilePhotoDataUrl",
                schema: "public",
                table: "users",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsFavorite",
                schema: "public",
                table: "contacts",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "friend_requests",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FromUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ToUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Message = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RespondedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_friend_requests", x => x.Id);
                    table.ForeignKey(
                        name: "FK_friend_requests_users_FromUserId",
                        column: x => x.FromUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_friend_requests_users_ToUserId",
                        column: x => x.ToUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "stories",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Visibility = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    EncryptedPayload = table.Column<string>(type: "text", nullable: false),
                    Caption = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    MediaFileObjectId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    allowed_user_ids = table.Column<string>(type: "jsonb", nullable: false),
                    viewed_by_user_ids = table.Column<string>(type: "jsonb", nullable: false),
                    ViewOnce = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_stories", x => x.Id);
                    table.ForeignKey(
                        name: "FK_stories_files_MediaFileObjectId",
                        column: x => x.MediaFileObjectId,
                        principalSchema: "public",
                        principalTable: "files",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_stories_users_OwnerUserId",
                        column: x => x.OwnerUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "vault_rooms",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    pin_algorithm = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    pin_iterations = table.Column<int>(type: "integer", nullable: true),
                    pin_salt = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    pin_hash = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    AccessMode = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    RetentionMode = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    EncryptedWelcome = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ClosedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_rooms", x => x.Id);
                    table.ForeignKey(
                        name: "FK_vault_rooms_users_OwnerUserId",
                        column: x => x.OwnerUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "vault_room_members",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    VaultRoomId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Role = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    JoinedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LeftAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_room_members", x => x.Id);
                    table.ForeignKey(
                        name: "FK_vault_room_members_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_vault_room_members_vault_rooms_VaultRoomId",
                        column: x => x.VaultRoomId,
                        principalSchema: "public",
                        principalTable: "vault_rooms",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_users_IsDiscoverable",
                schema: "public",
                table: "users",
                column: "IsDiscoverable");

            migrationBuilder.CreateIndex(
                name: "IX_users_Phone",
                schema: "public",
                table: "users",
                column: "Phone");

            migrationBuilder.CreateIndex(
                name: "IX_friend_requests_FromUserId_ToUserId_Status",
                schema: "public",
                table: "friend_requests",
                columns: new[] { "FromUserId", "ToUserId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_friend_requests_ToUserId_Status",
                schema: "public",
                table: "friend_requests",
                columns: new[] { "ToUserId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_stories_DeletedAt",
                schema: "public",
                table: "stories",
                column: "DeletedAt");

            migrationBuilder.CreateIndex(
                name: "IX_stories_MediaFileObjectId",
                schema: "public",
                table: "stories",
                column: "MediaFileObjectId");

            migrationBuilder.CreateIndex(
                name: "IX_stories_OwnerUserId_CreatedAt",
                schema: "public",
                table: "stories",
                columns: new[] { "OwnerUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_stories_Visibility_ExpiresAt",
                schema: "public",
                table: "stories",
                columns: new[] { "Visibility", "ExpiresAt" });

            migrationBuilder.CreateIndex(
                name: "IX_vault_room_members_UserId_Status",
                schema: "public",
                table: "vault_room_members",
                columns: new[] { "UserId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_vault_room_members_VaultRoomId_UserId",
                schema: "public",
                table: "vault_room_members",
                columns: new[] { "VaultRoomId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_vault_rooms_ExpiresAt",
                schema: "public",
                table: "vault_rooms",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_vault_rooms_OwnerUserId_ClosedAt",
                schema: "public",
                table: "vault_rooms",
                columns: new[] { "OwnerUserId", "ClosedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "friend_requests",
                schema: "public");

            migrationBuilder.DropTable(
                name: "stories",
                schema: "public");

            migrationBuilder.DropTable(
                name: "vault_room_members",
                schema: "public");

            migrationBuilder.DropTable(
                name: "vault_rooms",
                schema: "public");

            migrationBuilder.DropIndex(
                name: "IX_users_IsDiscoverable",
                schema: "public",
                table: "users");

            migrationBuilder.DropIndex(
                name: "IX_users_Phone",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "Bio",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "IsDiscoverable",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "ProfilePhotoDataUrl",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "IsFavorite",
                schema: "public",
                table: "contacts");
        }
    }
}
