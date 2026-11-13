import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { paiseTransformer } from './paise.transformer';

export const LEDGER_ENTRY_TYPES = [
  'charge',
  'payment',
  'late_fee',
  'waiver',
  'adjustment',
  'refund',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * INSERT ONLY. The table is append-only at the database level (UPDATE, DELETE and
 * TRUNCATE are rejected). Never call save() or update() on this entity.
 * Sign convention: charge / late_fee / refund > 0, payment / waiver < 0.
 */
@Entity({ name: 'ledger_entries' })
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'lease_id', type: 'uuid' })
  leaseId!: string;

  @Column({ name: 'rent_cycle_id', type: 'uuid' })
  rentCycleId!: string;

  @Column({ type: 'text' })
  type!: LedgerEntryType;

  @Column({
    name: 'amount_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  amountPaise!: number;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** null = system / background job. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
