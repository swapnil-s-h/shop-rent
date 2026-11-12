import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type NotificationChannel = 'push' | 'email' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

@Entity({ name: 'notification_outbox' })
export class NotificationOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  channel!: NotificationChannel;

  @Column({ type: 'text' })
  template!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** e.g. cycle:<id>:overdue:tenant. The unique key means it is never sent twice. */
  @Column({ name: 'dedupe_key', type: 'text' })
  dedupeKey!: string;

  @Column({ type: 'text' })
  status!: NotificationStatus;

  @Column({ type: 'int' })
  attempts!: number;

  @Column({ name: 'send_after', type: 'timestamptz' })
  sendAfter!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
