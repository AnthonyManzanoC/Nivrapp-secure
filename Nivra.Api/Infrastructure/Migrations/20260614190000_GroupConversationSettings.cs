using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260614190000_GroupConversationSettings")]
    public partial class GroupConversationSettings : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "group_edit_info",
                schema: "public",
                table: "conversations",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "admins");

            migrationBuilder.AddColumn<string>(
                name: "group_send_messages",
                schema: "public",
                table: "conversations",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "all");

            migrationBuilder.AddColumn<string>(
                name: "group_add_members",
                schema: "public",
                table: "conversations",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "admins");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "group_edit_info",
                schema: "public",
                table: "conversations");

            migrationBuilder.DropColumn(
                name: "group_send_messages",
                schema: "public",
                table: "conversations");

            migrationBuilder.DropColumn(
                name: "group_add_members",
                schema: "public",
                table: "conversations");
        }
    }
}
