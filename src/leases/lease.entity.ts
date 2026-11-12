import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { paiseTransformer } from '../payments/paise.transformer';

export const DUE_RULES = ['month_end', 'day_of_month'] as const;
export type DueRule = (typeof DUE_RULES)[number];

export const COLLECTION_MODES = ['auto_debit', 'manual'] as const;
export type CollectionMode = (typeof COLLECTION_MODES)[number];

export const LEASE_STATUSES = ['draft', 'active', 'ended'] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

@Entity({ name: 'leases' })
export class Lease {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId!: string;

  /** Denormalized from the shop; the database guarantees they match. */
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  /** Calendar dates are strings (YYYY-MM-DD, IST business dates). */
  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  @Column({
    name: 'deposit_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  depositPaise!: number;

  @Column({ name: 'due_rule', type: 'text' })
  dueRule!: DueRule;

  /** Day of month (1-31, clamped to the month's length) when dueRule is day_of_month. */
  @Column({ name: 'due_day', type: 'smallint', nullable: true })
  dueDay!: number | null;

  @Column({ name: 'grace_days', type: 'smallint' })
  graceDays!: number;

  /** Number of retries after the first debit attempt. */
  @Column({ name: 'retry_days', type: 'smallint' })
  retryDays!: number;

  @Column({ name: 'collection_mode', type: 'text' })
  collectionMode!: CollectionMode;

  @Column({ type: 'text' })
  status!: LeaseStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
