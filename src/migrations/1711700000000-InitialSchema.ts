import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1711700000000 implements MigrationInterface {
  name = 'InitialSchema1711700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ============================================================
    // Table 1: refresh_tokens
    // Purpose: Edge JWT session management and token rotation
    // ============================================================
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID            NOT NULL,
        install_id        UUID            NOT NULL,
        hardware_serial   VARCHAR(128),
        token_hash        VARCHAR(256)    NOT NULL UNIQUE,
        token_family      UUID            NOT NULL,
        rotation_count    INTEGER         NOT NULL DEFAULT 0,
        expires_at        TIMESTAMPTZ     NOT NULL,
        revoked_at        TIMESTAMPTZ,
        created_at        TIMESTAMPTZ     NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_refresh_tokens_install_id ON refresh_tokens (install_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_refresh_tokens_token_family ON refresh_tokens (token_family);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
    `);

    // ============================================================
    // Table 2: active_devices
    // Purpose: Single Active Device Rule enforcement
    // msme_id as PK enforces one device per MSME at schema level
    // ============================================================
    await queryRunner.query(`
      CREATE TABLE active_devices (
        msme_id           UUID            PRIMARY KEY,
        install_id        UUID            NOT NULL,
        hardware_serial   VARCHAR(128),
        user_id           UUID            NOT NULL,
        activated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
        last_seen_at      TIMESTAMPTZ     NOT NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_active_devices_install_id ON active_devices (install_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_active_devices_last_seen_at ON active_devices (last_seen_at);
    `);

    // ============================================================
    // Table 3: sync_queue_logs
    // Purpose: Action Queue / Outbox Pattern processing
    // ============================================================
    await queryRunner.query(`
      CREATE TABLE sync_queue_logs (
        id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_ref               UUID            NOT NULL,
        client_ref              UUID            NOT NULL UNIQUE,
        msme_id                 UUID            NOT NULL,
        install_id              UUID            NOT NULL,
        hardware_serial         VARCHAR(128),
        action_type             VARCHAR(32)     NOT NULL,
        recorded_at             TIMESTAMPTZ     NOT NULL,
        tax_rate_version        INTEGER,
        payload                 JSONB           NOT NULL,
        status                  VARCHAR(16)     NOT NULL DEFAULT 'pending',
        retry_count             INTEGER         NOT NULL DEFAULT 0,
        max_retries             INTEGER         NOT NULL DEFAULT 5,
        failure_reason          TEXT,
        erpnext_ref             VARCHAR(128),
        warnings                JSONB,
        received_at             TIMESTAMPTZ     NOT NULL DEFAULT now(),
        processing_started_at   TIMESTAMPTZ,
        completed_at            TIMESTAMPTZ,
        created_at              TIMESTAMPTZ     NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_sync_queue_logs_batch_ref ON sync_queue_logs (batch_ref);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sync_queue_logs_status_recorded_at ON sync_queue_logs (status, recorded_at);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sync_queue_logs_msme_id ON sync_queue_logs (msme_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sync_queue_logs_install_id ON sync_queue_logs (install_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sync_queue_logs_status_failed ON sync_queue_logs (status) WHERE status = 'failed';
    `);

    // ============================================================
    // Table 4: cached_tax_rates
    // Purpose: Versioned GRA Modified Tax System rate cache
    // ============================================================
    await queryRunner.query(`
      CREATE TABLE cached_tax_rates (
        id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
        tax_type            VARCHAR(64)     NOT NULL,
        rate_percent        DECIMAL(5,2)    NOT NULL,
        vat_status_scope    VARCHAR(32)     NOT NULL,
        effective_date      DATE            NOT NULL,
        version_id          INTEGER         NOT NULL,
        source_updated_at   TIMESTAMPTZ     NOT NULL,
        created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

        CONSTRAINT uq_cached_tax_rates_version
          UNIQUE (tax_type, vat_status_scope, version_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_cached_tax_rates_scope_effective ON cached_tax_rates (vat_status_scope, effective_date);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS cached_tax_rates;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sync_queue_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS active_devices;`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens;`);
  }
}
