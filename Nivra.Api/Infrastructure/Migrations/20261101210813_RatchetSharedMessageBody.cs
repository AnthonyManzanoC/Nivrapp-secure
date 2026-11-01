using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RatchetSharedMessageBody : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "SharedPayloadCiphertext",
                schema: "public",
                table: "messages",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SharedPayloadIv",
                schema: "public",
                table: "messages",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SharedPayloadCiphertext",
                schema: "public",
                table: "messages");

            migrationBuilder.DropColumn(
                name: "SharedPayloadIv",
                schema: "public",
                table: "messages");
        }
    }
}
