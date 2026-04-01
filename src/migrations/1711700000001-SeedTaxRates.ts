import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedTaxRates1711700000001 implements MigrationInterface {
  name = 'SeedTaxRates1711700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ============================================================
    // GRA Modified Tax System — Phase 1 Rates
    //
    // Legislative basis:
    //   - VAT Act 2013 (Act 870) — standard rate & VFRS flat rate
    //   - National Health Insurance Levy (NHIL)
    //   - Ghana Education Trust Fund Levy (GETFund)
    //   - COVID-19 Health Recovery Levy
    //
    // VAT regimes:
    //   - not_registered: Below GHS 200,000 → 0% (exempt, no rates)
    //   - flat_rate:      GHS 200,000–500,000 → 3% VFRS only
    //   - standard:       Above GHS 500,000 → VAT 15% + NHIL 2.5% + GETFund 2.5% + COVID 1%
    //
    // ON CONFLICT ensures idempotent re-runs.
    // ============================================================
    await queryRunner.query(`
      INSERT INTO cached_tax_rates
        (tax_type, rate_percent, vat_status_scope, effective_date, version_id, source_updated_at)
      VALUES
        ('vat_standard',  15.00, 'standard',  '2025-01-01', 1, now()),
        ('nhil',           2.50, 'standard',  '2025-01-01', 1, now()),
        ('getfund',        2.50, 'standard',  '2025-01-01', 1, now()),
        ('covid_levy',     1.00, 'standard',  '2025-01-01', 1, now()),
        ('vat_flat_rate',  3.00, 'flat_rate', '2025-01-01', 1, now())
      ON CONFLICT ON CONSTRAINT uq_cached_tax_rates_version DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM cached_tax_rates
      WHERE version_id = 1
        AND effective_date = '2025-01-01';
    `);
  }
}
