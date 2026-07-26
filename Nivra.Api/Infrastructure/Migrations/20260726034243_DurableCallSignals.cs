using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DurableCallSignals : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "call_signals",
                schema: "public",
                columns: table => new
                {
                    Id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CallId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FromUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FromDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    TargetUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SignalType = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PayloadCiphertext = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_call_signals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_call_signals_calls_CallId",
                        column: x => x.CallId,
                        principalSchema: "public",
                        principalTable: "calls",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_call_signals_CallId_TargetUserId_CreatedAt",
                schema: "public",
                table: "call_signals",
                columns: new[] { "CallId", "TargetUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_call_signals_ExpiresAt",
                schema: "public",
                table: "call_signals",
                column: "ExpiresAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "call_signals",
                schema: "public");
        }
    }
}
