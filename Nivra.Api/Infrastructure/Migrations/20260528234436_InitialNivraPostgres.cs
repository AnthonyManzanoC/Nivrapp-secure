using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class InitialNivraPostgres : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "public");

            migrationBuilder.CreateTable(
                name: "ad_campaigns",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Title = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    Body = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Placement = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Locale = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    Region = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    ClickUrl = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false),
                    StartsAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EndsAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ad_campaigns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "users",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Alias = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: true),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    Phone = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    PlanCode = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false, defaultValue: "free"),
                    password_algorithm = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    password_iterations = table.Column<int>(type: "integer", nullable: false),
                    password_salt = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    password_hash = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    privacy_hide_notification_content = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_allow_forwarding = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_allow_screenshots = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_read_receipts = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_default_message_ttl_seconds = table.Column<int>(type: "integer", nullable: true),
                    privacy_preset = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DisabledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_users", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ad_impressions",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    CampaignId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Placement = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Day = table.Column<DateOnly>(type: "date", nullable: false),
                    Count = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ad_impressions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ad_impressions_ad_campaigns_CampaignId",
                        column: x => x.CampaignId,
                        principalSchema: "public",
                        principalTable: "ad_campaigns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "contacts",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ContactUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    NicknameCiphertext = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_contacts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_contacts_users_ContactUserId",
                        column: x => x.ContactUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_contacts_users_OwnerUserId",
                        column: x => x.OwnerUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "conversations",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TitleCiphertext = table.Column<string>(type: "text", nullable: true),
                    CreatedByUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    privacy_hide_notification_content = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_allow_forwarding = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_allow_screenshots = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_read_receipts = table.Column<bool>(type: "boolean", nullable: false),
                    privacy_default_message_ttl_seconds = table.Column<int>(type: "integer", nullable: true),
                    privacy_preset = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastMessageAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_conversations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_conversations_users_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "devices",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Name = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    identity_key = table.Column<string>(type: "text", nullable: true),
                    signed_pre_key = table.Column<string>(type: "text", nullable: true),
                    pre_key_signature = table.Column<string>(type: "text", nullable: true),
                    one_time_pre_keys = table.Column<string>(type: "jsonb", nullable: false),
                    keys_last_rotated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    IsTrusted = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_devices", x => x.Id);
                    table.ForeignKey(
                        name: "FK_devices_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "files",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    StorageKey = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    EncryptedSize = table.Column<long>(type: "bigint", nullable: false),
                    MimeTypeCiphertext = table.Column<string>(type: "text", nullable: true),
                    ClientSha256 = table.Column<string>(type: "text", nullable: true),
                    State = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    allowed_user_ids = table.Column<string>(type: "jsonb", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UploadedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_files", x => x.Id);
                    table.ForeignKey(
                        name: "FK_files_users_OwnerUserId",
                        column: x => x.OwnerUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "security_audit_events",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Action = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    IpAddress = table.Column<string>(type: "character varying(96)", maxLength: 96, nullable: true),
                    Details = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_security_audit_events", x => x.Id);
                    table.ForeignKey(
                        name: "FK_security_audit_events_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "calls",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    InitiatorUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    participant_user_ids = table.Column<string>(type: "jsonb", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_calls", x => x.Id);
                    table.ForeignKey(
                        name: "FK_calls_conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalSchema: "public",
                        principalTable: "conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_calls_users_InitiatorUserId",
                        column: x => x.InitiatorUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "conversation_participants",
                schema: "public",
                columns: table => new
                {
                    user_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    conversation_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    role = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    can_invite = table.Column<bool>(type: "boolean", nullable: false),
                    can_change_privacy = table.Column<bool>(type: "boolean", nullable: false),
                    joined_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    removed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_conversation_participants", x => new { x.conversation_id, x.user_id });
                    table.ForeignKey(
                        name: "FK_conversation_participants_conversations_conversation_id",
                        column: x => x.conversation_id,
                        principalSchema: "public",
                        principalTable: "conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "messages",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ClientMessageId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    SenderUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SenderDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    EncryptedPolicy = table.Column<string>(type: "text", nullable: true),
                    ServerReceivedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    DeleteAfterRead = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_messages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_messages_conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalSchema: "public",
                        principalTable: "conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_messages_devices_SenderDeviceId",
                        column: x => x.SenderDeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_messages_users_SenderUserId",
                        column: x => x.SenderUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "push_tokens",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    DeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_push_tokens", x => x.Id);
                    table.ForeignKey(
                        name: "FK_push_tokens_devices_DeviceId",
                        column: x => x.DeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_push_tokens_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sessions",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    DeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    RefreshTokenHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedIp = table.Column<string>(type: "character varying(96)", maxLength: 96, nullable: true),
                    UserAgent = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sessions_devices_DeviceId",
                        column: x => x.DeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_sessions_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "vault_items",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ParentId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    FileObjectId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    EncryptedMetadata = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_items", x => x.Id);
                    table.ForeignKey(
                        name: "FK_vault_items_files_FileObjectId",
                        column: x => x.FileObjectId,
                        principalSchema: "public",
                        principalTable: "files",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_vault_items_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "message_receipts",
                schema: "public",
                columns: table => new
                {
                    user_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    device_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    message_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    delivered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    read_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_message_receipts", x => new { x.message_id, x.user_id, x.device_id });
                    table.ForeignKey(
                        name: "FK_message_receipts_messages_message_id",
                        column: x => x.message_id,
                        principalSchema: "public",
                        principalTable: "messages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "message_recipients",
                schema: "public",
                columns: table => new
                {
                    user_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    device_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    message_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ciphertext = table.Column<string>(type: "text", nullable: false),
                    header = table.Column<string>(type: "text", nullable: true),
                    file_object_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_message_recipients", x => new { x.message_id, x.user_id, x.device_id });
                    table.ForeignKey(
                        name: "FK_message_recipients_messages_message_id",
                        column: x => x.message_id,
                        principalSchema: "public",
                        principalTable: "messages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                schema: "public",
                table: "ad_campaigns",
                columns: new[] { "Id", "Body", "ClickUrl", "EndsAt", "IsActive", "Locale", "Placement", "Region", "StartsAt", "Title" },
                values: new object[] { "ad_nivra_launch", "Mas boveda cifrada y mas dispositivos cuando quieras crecer.", "https://nivra.app/premium", new DateTimeOffset(new DateTime(2036, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), true, "es", "vault_home", null, new DateTimeOffset(new DateTime(2026, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), "Nivra Premium" });

            migrationBuilder.CreateIndex(
                name: "IX_ad_campaigns_IsActive_StartsAt_EndsAt",
                schema: "public",
                table: "ad_campaigns",
                columns: new[] { "IsActive", "StartsAt", "EndsAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ad_impressions_CampaignId_Placement_Day",
                schema: "public",
                table: "ad_impressions",
                columns: new[] { "CampaignId", "Placement", "Day" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_calls_ConversationId",
                schema: "public",
                table: "calls",
                column: "ConversationId");

            migrationBuilder.CreateIndex(
                name: "IX_calls_InitiatorUserId_StartedAt",
                schema: "public",
                table: "calls",
                columns: new[] { "InitiatorUserId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_contacts_ContactUserId",
                schema: "public",
                table: "contacts",
                column: "ContactUserId");

            migrationBuilder.CreateIndex(
                name: "IX_contacts_OwnerUserId_ContactUserId",
                schema: "public",
                table: "contacts",
                columns: new[] { "OwnerUserId", "ContactUserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_conversation_participants_user_id_removed_at",
                schema: "public",
                table: "conversation_participants",
                columns: new[] { "user_id", "removed_at" });

            migrationBuilder.CreateIndex(
                name: "IX_conversations_CreatedByUserId",
                schema: "public",
                table: "conversations",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_conversations_LastMessageAt",
                schema: "public",
                table: "conversations",
                column: "LastMessageAt");

            migrationBuilder.CreateIndex(
                name: "IX_devices_UserId_RevokedAt",
                schema: "public",
                table: "devices",
                columns: new[] { "UserId", "RevokedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_files_ExpiresAt",
                schema: "public",
                table: "files",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_files_OwnerUserId",
                schema: "public",
                table: "files",
                column: "OwnerUserId");

            migrationBuilder.CreateIndex(
                name: "IX_files_StorageKey",
                schema: "public",
                table: "files",
                column: "StorageKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_message_receipts_user_id_device_id_deleted_at",
                schema: "public",
                table: "message_receipts",
                columns: new[] { "user_id", "device_id", "deleted_at" });

            migrationBuilder.CreateIndex(
                name: "IX_message_recipients_file_object_id",
                schema: "public",
                table: "message_recipients",
                column: "file_object_id");

            migrationBuilder.CreateIndex(
                name: "IX_message_recipients_user_id_device_id",
                schema: "public",
                table: "message_recipients",
                columns: new[] { "user_id", "device_id" });

            migrationBuilder.CreateIndex(
                name: "IX_messages_ConversationId_ServerReceivedAt",
                schema: "public",
                table: "messages",
                columns: new[] { "ConversationId", "ServerReceivedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_messages_ExpiresAt",
                schema: "public",
                table: "messages",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_messages_SenderDeviceId",
                schema: "public",
                table: "messages",
                column: "SenderDeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_messages_SenderUserId_ClientMessageId",
                schema: "public",
                table: "messages",
                columns: new[] { "SenderUserId", "ClientMessageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_push_tokens_DeviceId",
                schema: "public",
                table: "push_tokens",
                column: "DeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_push_tokens_TokenHash",
                schema: "public",
                table: "push_tokens",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_push_tokens_UserId_DeviceId_RevokedAt",
                schema: "public",
                table: "push_tokens",
                columns: new[] { "UserId", "DeviceId", "RevokedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_security_audit_events_UserId_CreatedAt",
                schema: "public",
                table: "security_audit_events",
                columns: new[] { "UserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_sessions_DeviceId_RevokedAt",
                schema: "public",
                table: "sessions",
                columns: new[] { "DeviceId", "RevokedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_sessions_RefreshTokenHash",
                schema: "public",
                table: "sessions",
                column: "RefreshTokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sessions_UserId_RevokedAt",
                schema: "public",
                table: "sessions",
                columns: new[] { "UserId", "RevokedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_users_Alias",
                schema: "public",
                table: "users",
                column: "Alias",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_users_DisabledAt",
                schema: "public",
                table: "users",
                column: "DisabledAt");

            migrationBuilder.CreateIndex(
                name: "IX_vault_items_FileObjectId",
                schema: "public",
                table: "vault_items",
                column: "FileObjectId");

            migrationBuilder.CreateIndex(
                name: "IX_vault_items_ParentId",
                schema: "public",
                table: "vault_items",
                column: "ParentId");

            migrationBuilder.CreateIndex(
                name: "IX_vault_items_UserId_DeletedAt",
                schema: "public",
                table: "vault_items",
                columns: new[] { "UserId", "DeletedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ad_impressions",
                schema: "public");

            migrationBuilder.DropTable(
                name: "calls",
                schema: "public");

            migrationBuilder.DropTable(
                name: "contacts",
                schema: "public");

            migrationBuilder.DropTable(
                name: "conversation_participants",
                schema: "public");

            migrationBuilder.DropTable(
                name: "message_receipts",
                schema: "public");

            migrationBuilder.DropTable(
                name: "message_recipients",
                schema: "public");

            migrationBuilder.DropTable(
                name: "push_tokens",
                schema: "public");

            migrationBuilder.DropTable(
                name: "security_audit_events",
                schema: "public");

            migrationBuilder.DropTable(
                name: "sessions",
                schema: "public");

            migrationBuilder.DropTable(
                name: "vault_items",
                schema: "public");

            migrationBuilder.DropTable(
                name: "ad_campaigns",
                schema: "public");

            migrationBuilder.DropTable(
                name: "messages",
                schema: "public");

            migrationBuilder.DropTable(
                name: "files",
                schema: "public");

            migrationBuilder.DropTable(
                name: "conversations",
                schema: "public");

            migrationBuilder.DropTable(
                name: "devices",
                schema: "public");

            migrationBuilder.DropTable(
                name: "users",
                schema: "public");
        }
    }
}
