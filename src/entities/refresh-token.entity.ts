import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('refresh_tokens')
@Index('idx_refresh_tokens_user_id', ['userId'])
@Index('idx_refresh_tokens_install_id', ['installId'])
@Index('idx_refresh_tokens_token_family', ['tokenFamily'])
@Index('idx_refresh_tokens_expires_at', ['expiresAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @Column({ type: 'uuid', nullable: false })
  installId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  hardwareSerial!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: false, unique: true })
  tokenHash!: string;

  @Column({ type: 'uuid', nullable: false })
  tokenFamily!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  rotationCount!: number;

  @Column({ type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
