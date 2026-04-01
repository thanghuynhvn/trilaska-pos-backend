import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

@Entity('active_devices')
@Index('idx_active_devices_install_id', ['installId'])
@Index('idx_active_devices_last_seen_at', ['lastSeenAt'])
export class ActiveDevice {
  @PrimaryColumn({ type: 'uuid' })
  msmeId!: string;

  @Column({ type: 'uuid', nullable: false })
  installId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  hardwareSerial!: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  activatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: false })
  lastSeenAt!: Date;
}
