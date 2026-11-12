import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { paiseTransformer } from '../payments/paise.transformer';

export const RENT_CYCLE_STATUSES = [
  'upcoming',
  'due',
  'processing',
  'retry_wait',
  'overdue',
  'partially_paid',
  'paid',
  'waived',
  'cancelled',
] as const;
export type RentCycleStatus = (typeof RENT_CYCLE_STATUSES)[number];

/** Cycles that can still receive money. paid, waived and cancelled are terminal. */
export const OPEN_RENT_CYCLE_STATUSES: readonly RentCycleStatus[] = [
  'due',
  'processing',
  'retry_wait',
  'overdue',
  'partially_paid',
];

/**
 * Status and money fields are written ONLY by PaymentService. The database
 * enforces allowed status transitions and freezes amount/period/lease.
 */
@Entity({ name: 'rent_cycles' })
export class RentCycle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'lease_id', type: 'uuid' })
  leaseId: string;

  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd: string;

  @Column({ name: 'due_date', type: 'date' })
  dueDate: string;

  /** Snapshot taken when the cycle was created. Never recomputed. */
  @Column({
    name: 'amount_due_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  amountDuePaise: number;

  @Column({ type: 'text' })
  status: RentCycleStatus;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  @Column({
    name: 'pre_debit_notified_at',
    type: 'timestamptz',
    nullable: true,
  })
  preDebitNotifiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
