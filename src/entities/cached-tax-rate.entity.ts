import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('cached_tax_rates')
@Unique('uq_cached_tax_rates_version', [
  'taxType',
  'vatStatusScope',
  'versionId',
])
@Index('idx_cached_tax_rates_scope_effective', [
  'vatStatusScope',
  'effectiveDate',
])
export class CachedTaxRate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  taxType!: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: false })
  ratePercent!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  vatStatusScope!: string;

  @Column({ type: 'date', nullable: false })
  effectiveDate!: string;

  @Column({ type: 'int', nullable: false })
  versionId!: number;

  @Column({ type: 'timestamptz', nullable: false })
  sourceUpdatedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
