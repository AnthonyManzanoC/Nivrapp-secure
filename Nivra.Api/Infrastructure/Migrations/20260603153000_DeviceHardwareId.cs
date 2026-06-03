using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260603153000_DeviceHardwareId")]
    /// <inheritdoc />
    public partial class DeviceHardwareId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "HardwareId",
                schema: "public",
                table: "devices",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_devices_UserId_HardwareId",
                schema: "public",
                table: "devices",
                columns: new[] { "UserId", "HardwareId" },
                unique: true,
                filter: "\"HardwareId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_devices_UserId_HardwareId",
                schema: "public",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HardwareId",
                schema: "public",
                table: "devices");
        }
    }
}
