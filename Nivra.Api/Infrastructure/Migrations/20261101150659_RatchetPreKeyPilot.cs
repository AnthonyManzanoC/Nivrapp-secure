using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RatchetPreKeyPilot : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ratchet_pilot_devices",
                schema: "public",
                columns: table => new
                {
                    DeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    IdentityKey = table.Column<string>(type: "character varying(44)", maxLength: 44, nullable: false),
                    SignalDeviceNumber = table.Column<int>(type: "integer", nullable: false),
                    RegistrationId = table.Column<int>(type: "integer", nullable: false),
                    HighWatermark = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ratchet_pilot_devices", x => x.DeviceId);
                    table.CheckConstraint("CK_ratchet_device_number", "\"SignalDeviceNumber\" BETWEEN 1 AND 127");
                    table.CheckConstraint("CK_ratchet_registration", "\"RegistrationId\" BETWEEN 1 AND 16379");
                    table.CheckConstraint("CK_ratchet_watermark", "\"HighWatermark\" BETWEEN 0 AND 4294967295");
                    table.ForeignKey(
                        name: "FK_ratchet_pilot_devices_devices_DeviceId",
                        column: x => x.DeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ratchet_pilot_devices_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ratchet_pilot_prekeys",
                schema: "public",
                columns: table => new
                {
                    DeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PreKeyId = table.Column<long>(type: "bigint", nullable: false),
                    BundleJson = table.Column<string>(type: "jsonb", nullable: false),
                    BundleHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ClaimRequestId = table.Column<Guid>(type: "uuid", nullable: true),
                    ClaimantDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ClaimedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ratchet_pilot_prekeys", x => new { x.DeviceId, x.PreKeyId });
                    table.CheckConstraint("CK_ratchet_bundle_size", "octet_length(\"BundleJson\"::text) <= 16384");
                    table.CheckConstraint("CK_ratchet_prekey_claim", "(\"ClaimRequestId\" IS NULL AND \"ClaimantDeviceId\" IS NULL AND \"ConversationId\" IS NULL AND \"ClaimedAt\" IS NULL) OR (\"ClaimRequestId\" IS NOT NULL AND \"ClaimantDeviceId\" IS NOT NULL AND \"ConversationId\" IS NOT NULL AND \"ClaimedAt\" IS NOT NULL)");
                    table.CheckConstraint("CK_ratchet_prekey_id", "\"PreKeyId\" BETWEEN 1 AND 4294967295");
                    table.ForeignKey(
                        name: "FK_ratchet_pilot_prekeys_ratchet_pilot_devices_DeviceId",
                        column: x => x.DeviceId,
                        principalSchema: "public",
                        principalTable: "ratchet_pilot_devices",
                        principalColumn: "DeviceId",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_pilot_devices_UserId_SignalDeviceNumber",
                schema: "public",
                table: "ratchet_pilot_devices",
                columns: new[] { "UserId", "SignalDeviceNumber" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_pilot_prekeys_ClaimantDeviceId_ClaimedAt",
                schema: "public",
                table: "ratchet_pilot_prekeys",
                columns: new[] { "ClaimantDeviceId", "ClaimedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_pilot_prekeys_DeviceId_ClaimantDeviceId_ClaimReques~",
                schema: "public",
                table: "ratchet_pilot_prekeys",
                columns: new[] { "DeviceId", "ClaimantDeviceId", "ClaimRequestId" },
                unique: true,
                filter: "\"ClaimRequestId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_prekeys_available",
                schema: "public",
                table: "ratchet_pilot_prekeys",
                columns: new[] { "DeviceId", "PreKeyId" },
                filter: "\"ClaimRequestId\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ratchet_pilot_prekeys",
                schema: "public");

            migrationBuilder.DropTable(
                name: "ratchet_pilot_devices",
                schema: "public");
        }
    }
}
