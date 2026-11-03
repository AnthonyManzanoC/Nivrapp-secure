using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class CallAnswerDismissalV9 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AnsweredDeviceId",
                schema: "public",
                table: "call_push_outbox",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DismissedAt",
                schema: "public",
                table: "call_push_outbox",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AnsweredDeviceId",
                schema: "public",
                table: "call_push_outbox");
            migrationBuilder.DropColumn(
                name: "DismissedAt",
                schema: "public",
                table: "call_push_outbox");
        }
    }
}
