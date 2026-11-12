import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DiscrepancyStatus = 'open' | 'resolved';

/** Anything that needs a human to look at money: flagged by PaymentService or reconciliation. */
@Entity({ name: 'discrepancies' })
export class Discrepancy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId: string | null;

  @Column({ type: 'text' })
  kind: string;

  @Column({ name: 'rent_cycle_id', type: 'uuid', nullable: true })
  rentCycleId: string | null;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ type: 'jsonb' })
  details: Record<string, unknown>;

  @Column({ type: 'text' })
  status: DiscrepancyStatus;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolved_note', type: 'text', nullable: true })
  resolvedNote: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
