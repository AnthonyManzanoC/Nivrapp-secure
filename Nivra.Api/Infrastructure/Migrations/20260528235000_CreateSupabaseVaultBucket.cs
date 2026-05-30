using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nivra.Api.Infrastructure;

#nullable disable

namespace Nivra.Api.Infrastructure.Migrations;

/// <inheritdoc />
[DbContext(typeof(NivraDbContext))]
[Migration("20260528235000_CreateSupabaseVaultBucket")]
public partial class CreateSupabaseVaultBucket : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'storage'
                      AND table_name = 'buckets'
                ) THEN
                    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
                    VALUES ('nivra-vault', 'nivra-vault', false, NULL, NULL)
                    ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name,
                        public = false;
                END IF;
            END
            $$;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'storage'
                      AND table_name = 'buckets'
                ) THEN
                    DELETE FROM storage.buckets
                    WHERE id = 'nivra-vault';
                END IF;
            END
            $$;
            """);
    }
}
