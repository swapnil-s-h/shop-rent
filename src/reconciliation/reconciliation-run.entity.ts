import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type ReconciliationRunStatus =
  'running' | 'ok' | 'discrepancies' | 'failed';

@Entity({ name: 'reconciliation_runs' })
export class ReconciliationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The day being reconciled (IST business date). */
  @Column({ name: 'run_date', type: 'date' })
  runDate: string;

  @Column({ type: 'text' })
  status: ReconciliationRunStatus;

  @Column({ type: 'jsonb', nullable: true })
  summary: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
