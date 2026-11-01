using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RatchetHistoryArchive : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "HistoryArchiveStream",
                schema: "public",
                columns: table => new
                {
                    TransferId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SourceDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    NextSequence = table.Column<int>(type: "integer", nullable: false),
                    AcknowledgedSequence = table.Column<int>(type: "integer", nullable: false),
                    Finished = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HistoryArchiveStream", x => new { x.TransferId, x.SourceDeviceId });
                    table.ForeignKey(
                        name: "FK_HistoryArchiveStream_HistoryKeyTransfers_TransferId",
                        column: x => x.TransferId,
                        principalSchema: "public",
                        principalTable: "HistoryKeyTransfers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "HistoryArchivePage",
                schema: "public",
                columns: table => new
                {
                    TransferId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    SourceDeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Sequence = table.Column<int>(type: "integer", nullable: false),
                    Header = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: false),
                    Ciphertext = table.Column<string>(type: "character varying(262144)", maxLength: 262144, nullable: false),
                    Final = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HistoryArchivePage", x => new { x.TransferId, x.SourceDeviceId, x.Sequence });
                    table.ForeignKey(
                        name: "FK_HistoryArchivePage_HistoryArchiveStream_TransferId_SourceDe~",
                        columns: x => new { x.TransferId, x.SourceDeviceId },
                        principalSchema: "public",
                        principalTable: "HistoryArchiveStream",
                        principalColumns: new[] { "TransferId", "SourceDeviceId" },
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HistoryArchivePage",
                schema: "public");

            migrationBuilder.DropTable(
                name: "HistoryArchiveStream",
                schema: "public");
        }
    }
}
