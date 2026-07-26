using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ProfilePhotoVisibility : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "privacy_profile_photo_visibility",
                schema: "public",
                table: "users",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "contacts");

            migrationBuilder.AddColumn<string>(
                name: "privacy_profile_photo_visibility",
                schema: "public",
                table: "conversations",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "contacts");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "privacy_profile_photo_visibility",
                schema: "public",
                table: "users");

            migrationBuilder.DropColumn(
                name: "privacy_profile_photo_visibility",
                schema: "public",
                table: "conversations");
        }
    }
}
