using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260726020000_StoryAllowReposts")]
    public partial class StoryAllowReposts : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "allow_reposts",
                schema: "public",
                table: "stories",
                type: "boolean",
                nullable: false,
                defaultValue: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "allow_reposts",
                schema: "public",
                table: "stories");
        }
    }
}
