using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class CallSessionOwnership : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "InitiatorDeviceId",
                schema: "public",
                table: "calls",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "InitiatorSessionId",
                schema: "public",
                table: "calls",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ParticipantSessions",
                schema: "public",
                table: "calls",
                type: "jsonb",
                nullable: false,
                defaultValue: "{}");

            migrationBuilder.AddColumn<string>(
                name: "FromClientSessionId",
                schema: "public",
                table: "call_signals",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TargetClientSessionId",
                schema: "public",
                table: "call_signals",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TargetDeviceId",
                schema: "public",
                table: "call_signals",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "InitiatorDeviceId",
                schema: "public",
                table: "calls");

            migrationBuilder.DropColumn(
                name: "InitiatorSessionId",
                schema: "public",
                table: "calls");

            migrationBuilder.DropColumn(
                name: "ParticipantSessions",
                schema: "public",
                table: "calls");

            migrationBuilder.DropColumn(
                name: "FromClientSessionId",
                schema: "public",
                table: "call_signals");

            migrationBuilder.DropColumn(
                name: "TargetClientSessionId",
                schema: "public",
                table: "call_signals");

            migrationBuilder.DropColumn(
                name: "TargetDeviceId",
                schema: "public",
                table: "call_signals");
        }
    }
}
