import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('sync_queue_logs')
@Index('idx_sync_queue_logs_batch_ref', ['batchRef'])
@Index('idx_sync_queue_logs_status_recorded_at', ['status', 'recordedAt'])
@Index('idx_sync_queue_logs_msme_id', ['msmeId'])
@Index('idx_sync_queue_logs_install_id', ['installId'])
export class SyncQueueLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  batchRef!: string;

  @Column({ type: 'uuid', nullable: false, unique: true })
  clientRef!: string;

  @Column({ type: 'uuid', nullable: false })
  msmeId!: string;

  @Column({ type: 'uuid', nullable: false })
  installId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  hardwareSerial!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: false })
  actionType!: string;

  @Column({ type: 'timestamptz', nullable: false })
  recordedAt!: Date;

  @Column({ type: 'int', nullable: true })
  taxRateVersion!: number | null;

  @Column({ type: 'jsonb', nullable: false })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, nullable: false, default: 'pending' })
  status!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  retryCount!: number;

  @Column({ type: 'int', nullable: false, default: 5 })
  maxRetries!: number;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  erpnextRef!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  warnings!: string[] | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  receivedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processingStartedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
