import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Clock } from '../common/clock';
import { Lease } from '../leases/lease.entity';
import { Mandate, type PaymentEnvironment } from '../mandates/mandate.entity';
import { Discrepancy } from '../reconciliation/discrepancy.entity';
import {
  OPEN_RENT_CYCLE_STATUSES,
  RentCycle,
  RentCycleStatus,
} from '../rent-cycles/rent-cycle.entity';
import { UserRole } from '../users/user.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { Payment } from './payment.entity';
import {
  DISCREPANCY,
  PAYMENT_ENV,
  PROVIDER_REJECTED,
  RETRY_DELAY_HOURS,
} from './payments.constants';

export interface Actor {
  id: string;
  role: UserRole;
}

export interface CreateCycleInput {
  leaseId: string;
  /** YYYY-MM-DD */
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountDuePaise: number;
}

export interface DebitAttempt {
  paymentId: string;
  cycleId: string;
  attemptNo: number;
  /** Send this to the provider (receipt/notes) so events can be mapped back. */
  idempotencyKey: string;
  amountPaise: number;
  mandate: {
    providerCustomerId: string | null;
    providerTokenId: string | null;
  };
}

/** How a provider event identifies a payment. providerRef is preferred. */
export interface ProviderPaymentRef {
  providerRef: string;
  idempotencyKey?: string;
}

export interface PaymentOutcome {
  paymentId: string;
  cycleId: string;
  cycleStatus: RentCycleStatus;
  /** false when the event was a duplicate or was flagged for a human instead of applied. */
  applied: boolean;
}

/**
 * THE ONLY WRITER of payments, ledger_entries and rent_cycle status/money fields.
 *
 * Rules every method follows:
 *  - One database transaction per operation; no network calls inside it.
 *  - Lock order is always rent_cycle first, then payment (no deadlocks).
 *  - Handlers are idempotent: replays and duplicates change nothing.
 *  - Money surprises (overpayment, success after failure, ...) are never auto-resolved;
 *    they are recorded in `discrepancies` for a human.
 *  - The database also enforces state transitions and the append-only ledger.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    @Inject(PAYMENT_ENV) private readonly paymentEnv: PaymentEnvironment,
  ) {}

  // ---------------------------------------------------------------------
  // Cycle creation
  // ---------------------------------------------------------------------

  /**
   * Creates the rent cycle and its single `charge` ledger entry in one transaction.
   * Safe to call repeatedly for the same (lease, period): the second call is a no-op.
   */
  async createCycleWithCharge(
    input: CreateCycleInput,
  ): Promise<{ cycleId: string; created: boolean }> {
    this.assertPositivePaise(input.amountDuePaise, 'amountDuePaise');

    return this.dataSource.transaction(async (m) => {
      const lease = await m.findOne(Lease, { where: { id: input.leaseId } });
      if (!lease) throw new NotFoundException('Lease not found');
      if (lease.status !== 'active') {
        throw new ConflictException(
          'Rent cycles can only be created for active leases',
        );
      }

      const inserted = await m.query<{ id: string }[]>(
        `INSERT INTO rent_cycles (lease_id, period_start, period_end, due_date, amount_due_paise)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lease_id, period_start) DO NOTHING
         RETURNING id`,
        [
          input.leaseId,
          input.periodStart,
          input.periodEnd,
          input.dueDate,
          input.amountDuePaise,
        ],
      );

      if (inserted.length === 0) {
        const existing = await m.findOneOrFail(RentCycle, {
          where: { leaseId: input.leaseId, periodStart: input.periodStart },
        });
        return { cycleId: existing.id, created: false };
      }

      const cycleId = inserted[0].id;
      await m.insert(LedgerEntry, {
        leaseId: input.leaseId,
        rentCycleId: cycleId,
        type: 'charge',
        amountPaise: input.amountDuePaise,
        paymentId: null,
        reason: null,
        createdBy: null,
      });
      return { cycleId, created: true };
    });
  }

  // ---------------------------------------------------------------------
  // Mandate (auto-debit) attempts
  // ---------------------------------------------------------------------

  /**
   * Step 1 of a debit: reserve an attempt. Records a `created` payment for the full
   * outstanding balance and returns what the caller needs to call the provider.
   * The cycle status does not change until the provider accepts (markSubmitted).
   * The one-in-flight unique index makes a concurrent second attempt fail.
   */
  async beginDebitAttempt(cycleId: string): Promise<DebitAttempt> {
    return this.dataSource.transaction(async (m) => {
      const cycle = await this.lockCycle(m, cycleId);

      if (!['upcoming', 'due', 'retry_wait'].includes(cycle.status)) {
        throw new ConflictException(
          `Cannot start a debit for a cycle in status ${cycle.status}`,
        );
      }

      const lease = await m.findOneOrFail(Lease, {
        where: { id: cycle.leaseId },
      });
      if (lease.status !== 'active' || lease.collectionMode !== 'auto_debit') {
        throw new ConflictException('Lease is not active for auto-debit');
      }

      const mandate = await m.findOne(Mandate, {
        where: { leaseId: lease.id, status: 'active', env: this.paymentEnv },
      });
      if (!mandate) {
        throw new ConflictException(
          `No active ${this.paymentEnv} mandate for this lease`,
        );
      }

      const balance = await this.getBalance(m, cycleId);
      if (balance <= 0) {
        throw new ConflictException('Nothing left to collect for this cycle');
      }
      if (balance > mandate.maxAmountPaise) {
        throw new ConflictException(
          'Outstanding amount exceeds the mandate maximum; collect another way',
        );
      }

      const used = await this.countBankAttempts(m, cycleId);
      if (used >= 1 + lease.retryDays) {
        throw new ConflictException('Retry window exhausted for this cycle');
      }

      const attemptNo = await this.nextAttemptNo(m, cycleId, 'mandate');
      const idempotencyKey = `${cycleId}:mandate:${attemptNo}`;
      const saved = await m.save(Payment, {
        rentCycleId: cycleId,
        method: 'mandate',
        attemptNo,
        amountPaise: balance,
        status: 'created',
        idempotencyKey,
        providerRef: null,
        failureCode: null,
        recordedBy: null,
        confirmedBy: null,
        disputedAt: null,
      });

      return {
        paymentId: saved.id,
        cycleId,
        attemptNo,
        idempotencyKey,
        amountPaise: balance,
        mandate: {
          providerCustomerId: mandate.providerCustomerId,
          providerTokenId: mandate.providerTokenId,
        },
      };
    });
  }

  /** Step 2: the provider accepted the debit request. Idempotent for the same providerRef. */
  async markSubmitted(paymentId: string, providerRef: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const { cycle, payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentById(m, paymentId),
      );
      if (
        payment.status === 'submitted' &&
        payment.providerRef === providerRef
      ) {
        return;
      }
      if (payment.status !== 'created') {
        throw new ConflictException(
          `Payment is ${payment.status}; cannot mark it submitted`,
        );
      }
      await this.ensureSubmitted(m, cycle, payment, providerRef);
    });
  }

  /**
   * The provider definitively rejected the request (nothing was created there).
   * Do NOT use this for timeouts or unknown outcomes: leave the payment `created`
   * and let the stale-payment resolver look it up at the provider.
   */
  async abandonAttempt(paymentId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const { payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentById(m, paymentId),
      );
      if (payment.status !== 'created') {
        throw new ConflictException(
          `Payment is ${payment.status}; only a created payment can be abandoned`,
        );
      }
      await m.update(
        Payment,
        { id: payment.id },
        { status: 'failed', failureCode: PROVIDER_REJECTED },
      );
    });
  }

  // ---------------------------------------------------------------------
  // Provider events (called by the webhook processor, never by clients)
  // ---------------------------------------------------------------------

  async handlePaymentSucceeded(
    ref: ProviderPaymentRef,
  ): Promise<PaymentOutcome> {
    return this.dataSource.transaction(async (m) => {
      const { cycle, payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentByProviderRef(m, ref),
      );
      this.assertProviderPayment(payment, ref);

      if (payment.status === 'succeeded' || payment.status === 'reversed') {
        return this.outcome(cycle, payment, false);
      }
      if (payment.status === 'failed') {
        // Out-of-order or contradictory events. Money may have moved; a human decides.
        await this.flag(m, DISCREPANCY.SUCCESS_AFTER_FAILURE, cycle, payment, {
          providerRef: ref.providerRef,
          failureCode: payment.failureCode,
          amountPaise: payment.amountPaise,
        });
        return this.outcome(cycle, payment, false);
      }

      await this.ensureSubmitted(m, cycle, payment, ref.providerRef);
      await m.update(Payment, { id: payment.id }, { status: 'succeeded' });
      payment.status = 'succeeded';
      await this.creditPayment(m, cycle, payment, null);
      return this.outcome(cycle, payment, true);
    });
  }

  /** A bank-side failure (e.g. insufficient funds). Schedules a retry or marks the cycle overdue. */
  async handlePaymentFailed(
    ref: ProviderPaymentRef,
    failureCode: string | null,
  ): Promise<PaymentOutcome> {
    return this.dataSource.transaction(async (m) => {
      const { cycle, payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentByProviderRef(m, ref),
      );
      this.assertProviderPayment(payment, ref);

      if (payment.status === 'failed') {
        return this.outcome(cycle, payment, false);
      }
      if (payment.status === 'succeeded' || payment.status === 'reversed') {
        await this.flag(m, DISCREPANCY.FAILURE_AFTER_SUCCESS, cycle, payment, {
          providerRef: ref.providerRef,
          failureCode,
        });
        return this.outcome(cycle, payment, false);
      }

      await this.ensureSubmitted(m, cycle, payment, ref.providerRef);
      await m.update(
        Payment,
        { id: payment.id },
        { status: 'failed', failureCode },
      );
      payment.status = 'failed';
      payment.failureCode = failureCode;

      if (cycle.status === 'processing') {
        const lease = await m.findOneOrFail(Lease, {
          where: { id: cycle.leaseId },
        });
        const used = await this.countBankAttempts(m, cycle.id);
        if (used < 1 + lease.retryDays) {
          const nextAttemptAt = new Date(
            this.clock.now().getTime() + RETRY_DELAY_HOURS * 3_600_000,
          );
          await m.update(
            RentCycle,
            { id: cycle.id },
            { status: 'retry_wait', nextAttemptAt },
          );
          cycle.status = 'retry_wait';
          cycle.nextAttemptAt = nextAttemptAt;
        } else {
          await m.update(
            RentCycle,
            { id: cycle.id },
            { status: 'overdue', nextAttemptAt: null },
          );
          cycle.status = 'overdue';
          cycle.nextAttemptAt = null;
        }
      }
      return this.outcome(cycle, payment, true);
    });
  }

  // ---------------------------------------------------------------------
  // Cash (two-sided: the owner records, the tenant confirms)
  // ---------------------------------------------------------------------

  /** Owner records cash. Nothing hits the ledger until the tenant confirms. */
  async recordCash(
    cycleId: string,
    amountPaise: number,
    actor: Actor,
  ): Promise<{ paymentId: string }> {
    this.assertPositivePaise(amountPaise, 'amountPaise');

    return this.dataSource.transaction(async (m) => {
      const cycle = await this.lockCycle(m, cycleId);
      const lease = await m.findOneOrFail(Lease, {
        where: { id: cycle.leaseId },
      });
      if (actor.role !== 'owner' || actor.id !== lease.ownerId) {
        throw new ForbiddenException('Only the lease owner can record cash');
      }
      if (!OPEN_RENT_CYCLE_STATUSES.includes(cycle.status)) {
        throw new ConflictException(
          `Cannot record cash for a cycle in status ${cycle.status}`,
        );
      }
      const balance = await this.getBalance(m, cycleId);
      if (amountPaise > balance) {
        throw new BadRequestException(
          `Amount exceeds the outstanding balance (${balance} paise)`,
        );
      }

      const attemptNo = await this.nextAttemptNo(m, cycleId, 'cash');
      const saved = await m.save(Payment, {
        rentCycleId: cycleId,
        method: 'cash',
        attemptNo,
        amountPaise,
        status: 'created',
        idempotencyKey: `${cycleId}:cash:${attemptNo}`,
        providerRef: null,
        failureCode: null,
        recordedBy: actor.id,
        confirmedBy: null,
        disputedAt: null,
      });
      return { paymentId: saved.id };
    });
  }

  /** Tenant confirms a cash payment. This is the moment it is credited to the ledger. */
  async confirmCash(paymentId: string, actor: Actor): Promise<PaymentOutcome> {
    return this.dataSource.transaction(async (m) => {
      const { cycle, payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentById(m, paymentId),
      );
      const lease = await m.findOneOrFail(Lease, {
        where: { id: cycle.leaseId },
      });
      if (payment.method !== 'cash') {
        throw new BadRequestException('Not a cash payment');
      }
      if (actor.role !== 'tenant' || actor.id !== lease.tenantId) {
        throw new ForbiddenException('Only the lease tenant can confirm cash');
      }
      if (payment.status === 'succeeded') {
        return this.outcome(cycle, payment, false);
      }
      if (payment.status !== 'created') {
        throw new ConflictException(`Payment is ${payment.status}`);
      }
      if (payment.disputedAt) {
        throw new ConflictException(
          'Payment is disputed; the owner must re-record it',
        );
      }

      await m.update(
        Payment,
        { id: payment.id },
        { status: 'succeeded', confirmedBy: actor.id },
      );
      payment.status = 'succeeded';
      payment.confirmedBy = actor.id;
      await this.creditPayment(m, cycle, payment, actor.id);
      return this.outcome(cycle, payment, true);
    });
  }

  /** Tenant disputes a cash payment. It stays pending and visible to the owner. */
  async disputeCash(paymentId: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const { cycle, payment } = await this.lockCycleAndPayment(m, () =>
        this.findPaymentById(m, paymentId),
      );
      const lease = await m.findOneOrFail(Lease, {
        where: { id: cycle.leaseId },
      });
      if (payment.method !== 'cash' || payment.status !== 'created') {
        throw new ConflictException(
          'Only a pending cash payment can be disputed',
        );
      }
      if (actor.role !== 'tenant' || actor.id !== lease.tenantId) {
        throw new ForbiddenException('Only the lease tenant can dispute cash');
      }
      await m.update(
        Payment,
        { id: payment.id },
        { disputedAt: this.clock.now() },
      );
    });
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /** Outstanding balance in paise (ledger sum). <= 0 means fully paid. */
  async getCycleBalance(cycleId: string): Promise<number> {
    return this.getBalance(this.dataSource.manager, cycleId);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async creditPayment(
    m: EntityManager,
    cycle: RentCycle,
    payment: Payment,
    createdBy: string | null,
  ): Promise<void> {
    await m.insert(LedgerEntry, {
      leaseId: cycle.leaseId,
      rentCycleId: cycle.id,
      type: 'payment',
      amountPaise: -payment.amountPaise,
      paymentId: payment.id,
      reason: null,
      createdBy,
    });

    const balance = await this.getBalance(m, cycle.id);

    if (!OPEN_RENT_CYCLE_STATUSES.includes(cycle.status)) {
      // paid / waived / cancelled / upcoming: status stays, a human reviews the money.
      await this.flag(
        m,
        cycle.status === 'paid' || balance < 0
          ? DISCREPANCY.OVERPAYMENT
          : DISCREPANCY.PAYMENT_ON_CLOSED_CYCLE,
        cycle,
        payment,
        { cycleStatus: cycle.status, balancePaise: balance },
      );
      return;
    }

    if (balance < 0) {
      await this.flag(m, DISCREPANCY.OVERPAYMENT, cycle, payment, {
        balancePaise: balance,
      });
    }

    const target: RentCycleStatus = balance <= 0 ? 'paid' : 'partially_paid';
    if (target !== cycle.status) {
      await m.update(
        RentCycle,
        { id: cycle.id },
        { status: target, nextAttemptAt: null },
      );
      cycle.status = target;
      cycle.nextAttemptAt = null;
    }
  }

  /** created -> submitted (and cycle -> processing). Also used when an event beats markSubmitted. */
  private async ensureSubmitted(
    m: EntityManager,
    cycle: RentCycle,
    payment: Payment,
    providerRef: string,
  ): Promise<void> {
    if (payment.status !== 'created') return;

    await m.update(
      Payment,
      { id: payment.id },
      { status: 'submitted', providerRef },
    );
    payment.status = 'submitted';
    payment.providerRef = providerRef;

    if (['upcoming', 'due', 'retry_wait'].includes(cycle.status)) {
      await m.update(
        RentCycle,
        { id: cycle.id },
        { status: 'processing', nextAttemptAt: null },
      );
      cycle.status = 'processing';
      cycle.nextAttemptAt = null;
    }
  }

  private assertProviderPayment(payment: Payment, ref: ProviderPaymentRef) {
    if (payment.method === 'cash') {
      throw new ConflictException(
        'Cash payments are confirmed by the tenant, not by provider events',
      );
    }
    if (payment.providerRef && payment.providerRef !== ref.providerRef) {
      throw new ConflictException(
        'Provider reference does not match the stored one',
      );
    }
  }

  private async flag(
    m: EntityManager,
    kind: string,
    cycle: RentCycle,
    payment: Payment,
    details: Record<string, unknown>,
  ): Promise<void> {
    await m.save(Discrepancy, {
      runId: null,
      kind,
      rentCycleId: cycle.id,
      paymentId: payment.id,
      details,
      status: 'open',
    });
  }

  private outcome(
    cycle: RentCycle,
    payment: Payment,
    applied: boolean,
  ): PaymentOutcome {
    return {
      paymentId: payment.id,
      cycleId: cycle.id,
      cycleStatus: cycle.status,
      applied,
    };
  }

  /** Bank-side attempts used so far. Provider-rejected attempts do not count. */
  private async countBankAttempts(
    m: EntityManager,
    cycleId: string,
  ): Promise<number> {
    return m
      .createQueryBuilder(Payment, 'p')
      .where('p.rentCycleId = :cycleId', { cycleId })
      .andWhere('p.method = :method', { method: 'mandate' })
      .andWhere(
        "(p.status <> 'failed' OR COALESCE(p.failureCode, '') <> :code)",
        {
          code: PROVIDER_REJECTED,
        },
      )
      .getCount();
  }

  private async nextAttemptNo(
    m: EntityManager,
    cycleId: string,
    method: 'mandate' | 'cash',
  ): Promise<number> {
    const rows = await m.query<{ max: number }[]>(
      `SELECT COALESCE(MAX(attempt_no), 0)::int AS max
         FROM payments WHERE rent_cycle_id = $1 AND method = $2`,
      [cycleId, method],
    );
    return rows[0].max + 1;
  }

  private async getBalance(m: EntityManager, cycleId: string): Promise<number> {
    const rows = await m.query<{ balance: string }[]>(
      `SELECT COALESCE(SUM(amount_paise), 0)::text AS balance
         FROM ledger_entries WHERE rent_cycle_id = $1`,
      [cycleId],
    );
    const balance = Number(rows[0].balance);
    if (!Number.isSafeInteger(balance)) {
      throw new Error(
        `Ledger balance is not a safe integer: ${rows[0].balance}`,
      );
    }
    return balance;
  }

  private async lockCycle(m: EntityManager, id: string): Promise<RentCycle> {
    const cycle = await m.findOne(RentCycle, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!cycle) throw new NotFoundException(`Rent cycle ${id} not found`);
    return cycle;
  }

  /** Lock order: cycle first, then payment. */
  private async lockCycleAndPayment(
    m: EntityManager,
    lookup: () => Promise<Payment>,
  ): Promise<{ cycle: RentCycle; payment: Payment }> {
    const peek = await lookup();
    const cycle = await this.lockCycle(m, peek.rentCycleId);
    const payment = await m.findOne(Payment, {
      where: { id: peek.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) throw new NotFoundException(`Payment ${peek.id} not found`);
    return { cycle, payment };
  }

  private async findPaymentById(
    m: EntityManager,
    id: string,
  ): Promise<Payment> {
    const payment = await m.findOne(Payment, { where: { id } });
    if (!payment) throw new NotFoundException(`Payment ${id} not found`);
    return payment;
  }

  private async findPaymentByProviderRef(
    m: EntityManager,
    ref: ProviderPaymentRef,
  ): Promise<Payment> {
    let payment = await m.findOne(Payment, {
      where: { providerRef: ref.providerRef },
    });
    if (!payment && ref.idempotencyKey) {
      payment = await m.findOne(Payment, {
        where: { idempotencyKey: ref.idempotencyKey },
      });
    }
    if (!payment) {
      throw new NotFoundException(
        `No payment for provider reference ${ref.providerRef}`,
      );
    }
    return payment;
  }

  private assertPositivePaise(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException(
        `${name} must be a positive integer (paise)`,
      );
    }
  }
}
