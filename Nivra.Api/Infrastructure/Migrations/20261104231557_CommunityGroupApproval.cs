using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class CommunityGroupApproval : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "community_group_requests",
                schema: "public",
                columns: table => new
                {
                    CommunityId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    RequestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeclinedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_community_group_requests", x => new { x.CommunityId, x.ConversationId, x.UserId });
                    table.ForeignKey(
                        name: "FK_community_group_requests_community_groups_CommunityId_Conve~",
                        columns: x => new { x.CommunityId, x.ConversationId },
                        principalSchema: "public",
                        principalTable: "community_groups",
                        principalColumns: new[] { "CommunityId", "ConversationId" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_community_group_requests_users_UserId",
                        column: x => x.UserId,
                        principalSchema: "public",
                        principalTable: "users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_community_group_requests_CommunityId_UserId",
                schema: "public",
                table: "community_group_requests",
                columns: new[] { "CommunityId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_community_group_requests_UserId",
                schema: "public",
                table: "community_group_requests",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "community_group_requests",
                schema: "public");
        }
    }
}
