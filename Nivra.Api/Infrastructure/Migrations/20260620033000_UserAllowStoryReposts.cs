using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260620033000_UserAllowStoryReposts")]
    /// <inheritdoc />
    public partial class UserAllowStoryReposts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "AllowStoryReposts",
                schema: "public",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AllowStoryReposts",
                schema: "public",
                table: "users");
        }
    }
}
