using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DurableCallPushOutbox : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_calls_Status_StartedAt", schema: "public", table: "calls", columns: new[] { "Status", "StartedAt" });

            migrationBuilder.CreateTable(
                name: "call_push_outbox",
                schema: "public",
                columns: table => new
                {
                    CallId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    RecipientUserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    NextAttemptAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    LeaseId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    LeaseUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_call_push_outbox", x => new { x.CallId, x.RecipientUserId });
                    table.ForeignKey(
                        name: "FK_call_push_outbox_calls_CallId",
                        column: x => x.CallId,
                        principalSchema: "public",
                        principalTable: "calls",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_call_push_outbox_users_RecipientUserId",
                        column: x => x.RecipientUserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_call_push_outbox_CompletedAt_NextAttemptAt_LeaseUntil",
                schema: "public",
                table: "call_push_outbox",
                columns: new[] { "CompletedAt", "NextAttemptAt", "LeaseUntil" });

            migrationBuilder.CreateIndex(
                name: "IX_call_push_outbox_ExpiresAt",
                schema: "public",
                table: "call_push_outbox",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_call_push_outbox_RecipientUserId",
                schema: "public",
                table: "call_push_outbox",
                column: "RecipientUserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_calls_Status_StartedAt", schema: "public", table: "calls");
            migrationBuilder.DropTable(
                name: "call_push_outbox",
                schema: "public");
        }
    }
}
