using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DeviceContinuityV9 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ContinuitySignature",
                schema: "public",
                table: "devices",
                type: "character varying(88)",
                maxLength: 88,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ContinuitySourceDeviceId",
                schema: "public",
                table: "devices",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ContinuitySignature",
                schema: "public",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "ContinuitySourceDeviceId",
                schema: "public",
                table: "devices");
        }
    }
}
