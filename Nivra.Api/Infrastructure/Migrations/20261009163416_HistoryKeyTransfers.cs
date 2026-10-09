using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class HistoryKeyTransfers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "HistoryKeyTransfers",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", nullable: false),
                    TargetDeviceId = table.Column<string>(type: "text", nullable: false),
                    TargetIdentityKey = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HistoryKeyTransfers", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HistoryKeyTransfers_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "HistoryKeyTransferResponses",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    TransferId = table.Column<string>(type: "text", nullable: false),
                    SourceDeviceId = table.Column<string>(type: "text", nullable: false),
                    SourceIdentityKey = table.Column<string>(type: "text", nullable: false),
                    Header = table.Column<string>(type: "text", nullable: false),
                    Ciphertext = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HistoryKeyTransferResponses", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HistoryKeyTransferResponses_HistoryKeyTransfers_TransferId",
                        column: x => x.TransferId,
                        principalSchema: "public",
                        principalTable: "HistoryKeyTransfers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_HistoryKeyTransferResponses_TransferId",
                schema: "public",
                table: "HistoryKeyTransferResponses",
                column: "TransferId");

            migrationBuilder.CreateIndex(
                name: "IX_HistoryKeyTransfers_UserId_TargetDeviceId_ExpiresAt",
                schema: "public",
                table: "HistoryKeyTransfers",
                columns: new[] { "UserId", "TargetDeviceId", "ExpiresAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HistoryKeyTransferResponses",
                schema: "public");

            migrationBuilder.DropTable(
                name: "HistoryKeyTransfers",
                schema: "public");
        }
    }
}
