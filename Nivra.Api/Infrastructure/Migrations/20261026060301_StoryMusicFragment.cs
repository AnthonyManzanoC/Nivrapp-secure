using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class StoryMusicFragment : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MusicFileObjectId",
                schema: "public",
                table: "stories",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_stories_MusicFileObjectId",
                schema: "public",
                table: "stories",
                column: "MusicFileObjectId");

            migrationBuilder.AddForeignKey(
                name: "FK_stories_files_MusicFileObjectId",
                schema: "public",
                table: "stories",
                column: "MusicFileObjectId",
                principalSchema: "public",
                principalTable: "files",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_stories_files_MusicFileObjectId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropIndex(
                name: "IX_stories_MusicFileObjectId",
                schema: "public",
                table: "stories");

            migrationBuilder.DropColumn(
                name: "MusicFileObjectId",
                schema: "public",
                table: "stories");
        }
    }
}
