using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(NivraDbContext))]
    [Migration("20260530010000_VaultRoomFiles")]
    public partial class VaultRoomFiles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "VaultRoomId",
                schema: "public",
                table: "files",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_files_VaultRoomId",
                schema: "public",
                table: "files",
                column: "VaultRoomId");

            migrationBuilder.AddForeignKey(
                name: "FK_files_vault_rooms_VaultRoomId",
                schema: "public",
                table: "files",
                column: "VaultRoomId",
                principalSchema: "public",
                principalTable: "vault_rooms",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_files_vault_rooms_VaultRoomId",
                schema: "public",
                table: "files");

            migrationBuilder.DropIndex(
                name: "IX_files_VaultRoomId",
                schema: "public",
                table: "files");

            migrationBuilder.DropColumn(
                name: "VaultRoomId",
                schema: "public",
                table: "files");
        }
    }
}
