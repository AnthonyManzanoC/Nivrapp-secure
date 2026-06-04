using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260604010000_StoryInteractionsAndReposts")]
    /// <inheritdoc />
    public partial class StoryInteractionsAndReposts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "TargetType",
                schema: "public",
                table: "stories",
                type: "character varying(32)",
                maxLength: 32,
                nullable: false,
                defaultValue: "contacts");

            migrationBuilder.AddColumn<string>(
                name: "TargetId",
                schema: "public",
                table: "stories",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OriginalStoryId",
                schema: "public",
                table: "stories",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OriginalAuthorId",
                schema: "public",
                table: "stories",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "view_events",
                schema: "public",
                table: "stories",
                type: "jsonb",
                nullable: false,
                defaultValueSql: "'[]'::jsonb");

            migrationBuilder.AddColumn<string>(
                name: "reactions",
                schema: "public",
                table: "stories",
                type: "jsonb",
                nullable: false,
                defaultValueSql: "'[]'::jsonb");

            migrationBuilder.AddColumn<string>(
                name: "comments",
                schema: "public",
                table: "stories",
                type: "jsonb",
                nullable: false,
                defaultValueSql: "'[]'::jsonb");

            migrationBuilder.CreateIndex(
                name: "IX_stories_TargetType_TargetId",
                schema: "public",
                table: "stories",
                columns: new[] { "TargetType", "TargetId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_stories_TargetType_TargetId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "comments",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "reactions",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "view_events",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "OriginalAuthorId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "OriginalStoryId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "TargetId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "TargetType",
                schema: "public",
                table: "stories");
        }
    }
}
