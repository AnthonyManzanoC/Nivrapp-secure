using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260615033000_GroupConversationProfile")]
    public partial class GroupConversationProfile : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "group_name",
                schema: "public",
                table: "conversations",
                type: "character varying(80)",
                maxLength: 80,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "group_avatar",
                schema: "public",
                table: "conversations",
                type: "text",
                nullable: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "group_name",
                schema: "public",
                table: "conversations");

            migrationBuilder.DropColumn(
                name: "group_avatar",
                schema: "public",
                table: "conversations");
        }
    }
}
