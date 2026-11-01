using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RatchetClientDirectory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ratchet_pilot_devices_UserId_SignalDeviceNumber",
                schema: "public",
                table: "ratchet_pilot_devices");

            migrationBuilder.AddColumn<int>(
                name: "AddressMode",
                schema: "public",
                table: "ratchet_pilot_devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "ratchet_binding_requests",
                schema: "public",
                columns: table => new
                {
                    SourceDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TargetDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    RequestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ratchet_binding_requests", x => new { x.SourceDeviceId, x.TargetDeviceId });
                    table.ForeignKey(
                        name: "FK_ratchet_binding_requests_devices_SourceDeviceId",
                        column: x => x.SourceDeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ratchet_binding_requests_devices_TargetDeviceId",
                        column: x => x.TargetDeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ratchet_device_bindings",
                schema: "public",
                columns: table => new
                {
                    SourceDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TargetDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TargetIdentity = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Header = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: false),
                    Ciphertext = table.Column<string>(type: "character varying(16384)", maxLength: 16384, nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ratchet_device_bindings", x => new { x.SourceDeviceId, x.TargetDeviceId });
                    table.ForeignKey(
                        name: "FK_ratchet_device_bindings_devices_SourceDeviceId",
                        column: x => x.SourceDeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ratchet_device_bindings_devices_TargetDeviceId",
                        column: x => x.TargetDeviceId,
                        principalSchema: "public",
                        principalTable: "devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_pilot_devices_UserId_SignalDeviceNumber",
                schema: "public",
                table: "ratchet_pilot_devices",
                columns: new[] { "UserId", "SignalDeviceNumber" },
                unique: true,
                filter: "\"AddressMode\" = 0");

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_binding_requests_TargetDeviceId_RequestedAt",
                schema: "public",
                table: "ratchet_binding_requests",
                columns: new[] { "TargetDeviceId", "RequestedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_device_bindings_TargetDeviceId",
                schema: "public",
                table: "ratchet_device_bindings",
                column: "TargetDeviceId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ratchet_binding_requests",
                schema: "public");

            migrationBuilder.DropTable(
                name: "ratchet_device_bindings",
                schema: "public");

            migrationBuilder.DropIndex(
                name: "IX_ratchet_pilot_devices_UserId_SignalDeviceNumber",
                schema: "public",
                table: "ratchet_pilot_devices");

            migrationBuilder.DropColumn(
                name: "AddressMode",
                schema: "public",
                table: "ratchet_pilot_devices");

            migrationBuilder.CreateIndex(
                name: "IX_ratchet_pilot_devices_UserId_SignalDeviceNumber",
                schema: "public",
                table: "ratchet_pilot_devices",
                columns: new[] { "UserId", "SignalDeviceNumber" },
                unique: true);
        }
    }
}
