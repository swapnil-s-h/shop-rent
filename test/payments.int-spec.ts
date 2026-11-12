/**
 * Integration tests for PaymentService against a REAL PostgreSQL database.
 * They are not part of `npm test` (CI has no database). Run with:
 *
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/shop_rent_test npm run test:int
 *
 * The database name MUST end with `_test`: the schema is dropped and recreated.
 */
import { join } from 'path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Clock } from '../src/common/clock';
import { PaymentService } from '../src/payments/payments.service';

class TestClock extends Clock {
  current = new Date('2026-11-29T05:00:00.000Z');
  now(): Date {
    return this.current;
  }
}

let ds: DataSource;
let service: PaymentService;
const clock = new TestClock();
let seq = 0;

interface Fixture {
  leaseId: string;
  ownerId: string;
  tenantId: string;
  cycleId: string;
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return ds.query<T[]>(sql, params);
}

async function makeFixture(
  opts: {
    retryDays?: number;
    mandate?: boolean;
    mandateEnv?: 'test' | 'live';
    maxAmountPaise?: number;
    collectionMode?: 'auto_debit' | 'manual';
    amountDuePaise?: number;
    due?: boolean;
    noCycle?: boolean;
  } = {},
): Promise<Fixture> {
  seq++;
  const phone = (n: number) => `+919${String(n).padStart(9, '0')}`;
  const [owner] = await rows<{ id: string }>(
    `INSERT INTO users (role, phone, name, status) VALUES ('owner', $1, 'Owner', 'active') RETURNING id`,
    [phone(seq * 10 + 1)],
  );
  const [tenant] = await rows<{ id: string }>(
    `INSERT INTO users (role, phone, name, status) VALUES ('tenant', $1, 'Tenant', 'active') RETURNING id`,
    [phone(seq * 10 + 2)],
  );
  const [shop] = await rows<{ id: string }>(
    `INSERT INTO shops (owner_id, label) VALUES ($1, $2) RETURNING id`,
    [owner.id, `Shop ${seq}`],
  );
  const [lease] = await rows<{ id: string }>(
    `INSERT INTO leases (shop_id, owner_id, tenant_id, start_date, status, retry_days, collection_mode)
     VALUES ($1, $2, $3, '2026-01-01', 'active', $4, $5) RETURNING id`,
    [
      shop.id,
      owner.id,
      tenant.id,
      opts.retryDays ?? 5,
      opts.collectionMode ?? 'auto_debit',
    ],
  );
  if (opts.mandate !== false) {
    await rows(
      `INSERT INTO mandates (lease_id, env, provider_customer_id, provider_token_id, max_amount_paise, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [
        lease.id,
        opts.mandateEnv ?? 'test',
        `cust_${seq}`,
        `token_${seq}`,
        opts.maxAmountPaise ?? 1_500_000,
      ],
    );
  }
  if (opts.noCycle) {
    return {
      leaseId: lease.id,
      ownerId: owner.id,
      tenantId: tenant.id,
      cycleId: '',
    };
  }
  const { cycleId } = await service.createCycleWithCharge({
    leaseId: lease.id,
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    dueDate: '2026-11-30',
    amountDuePaise: opts.amountDuePaise ?? 1_000_000,
  });
  if (opts.due) await setStatus(cycleId, 'due');
  return {
    leaseId: lease.id,
    ownerId: owner.id,
    tenantId: tenant.id,
    cycleId,
  };
}

async function setStatus(cycleId: string, status: string) {
  await rows(`UPDATE rent_cycles SET status = $2 WHERE id = $1`, [
    cycleId,
    status,
  ]);
}

async function cycleRow(cycleId: string) {
  const [row] = await rows<{ status: string; next_attempt_at: Date | null }>(
    `SELECT status, next_attempt_at FROM rent_cycles WHERE id = $1`,
    [cycleId],
  );
  return row;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await rows<{ n: string }>(sql, params);
  return Number(row.n);
}

const ledgerCount = (cycleId: string, type?: string) =>
  count(
    `SELECT COUNT(*) AS n FROM ledger_entries WHERE rent_cycle_id = $1 AND ($2::text IS NULL OR type = $2)`,
    [cycleId, type ?? null],
  );

const discrepancies = (cycleId: string, kind: string) =>
  count(
    `SELECT COUNT(*) AS n FROM discrepancies WHERE rent_cycle_id = $1 AND kind = $2`,
    [cycleId, kind],
  );

/** begin -> provider accepted. Returns the attempt. */
async function startAndSubmit(f: Fixture, providerRef: string) {
  const attempt = await service.beginDebitAttempt(f.cycleId);
  await service.markSubmitted(attempt.paymentId, providerRef);
  return attempt;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL_TEST;
  if (!url)
    throw new Error(
      'Set DATABASE_URL_TEST (database name must end with _test)',
    );
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('Refusing to run: database name must end with _test');
  }
  ds = new DataSource({
    type: 'postgres',
    url,
    entities: [join(__dirname, '..', 'src', '**', '*.entity.ts')],
    migrations: [
      join(__dirname, '..', 'src', 'database', 'migrations', '*.ts'),
    ],
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('DROP SCHEMA public CASCADE');
  await ds.query('CREATE SCHEMA public');
  await ds.runMigrations();
  service = new PaymentService(ds, clock, 'test');
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

describe('createCycleWithCharge', () => {
  it('is idempotent, even under concurrency', async () => {
    const f = await makeFixture();
    const input = {
      leaseId: f.leaseId,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      dueDate: '2026-11-30',
      amountDuePaise: 1_000_000,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.createCycleWithCharge(input)),
    );
    expect(results.every((r) => r.cycleId === f.cycleId)).toBe(true);
    expect(results.filter((r) => r.created)).toHaveLength(0); // already created by the fixture
    expect(await ledgerCount(f.cycleId, 'charge')).toBe(1);
    expect(await service.getCycleBalance(f.cycleId)).toBe(1_000_000);
  });

  it('creates exactly one cycle and one charge when the first creation races', async () => {
    const f = await makeFixture({ noCycle: true });
    const input = {
      leaseId: f.leaseId,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      dueDate: '2026-11-30',
      amountDuePaise: 1_000_000,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.createCycleWithCharge(input)),
    );
    expect(new Set(results.map((r) => r.cycleId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const cycleId = results[0].cycleId;
    expect(await ledgerCount(cycleId, 'charge')).toBe(1);
    expect(await service.getCycleBalance(cycleId)).toBe(1_000_000);
  });

  it('rejects non-integer amounts and inactive leases', async () => {
    const f = await makeFixture();
    await expect(
      service.createCycleWithCharge({
        leaseId: f.leaseId,
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-31',
        amountDuePaise: 100.5,
      }),
    ).rejects.toThrow(BadRequestException);

    await rows(`UPDATE leases SET status = 'ended' WHERE id = $1`, [f.leaseId]);
    await expect(
      service.createCycleWithCharge({
        leaseId: f.leaseId,
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-31',
        amountDuePaise: 100_000,
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('mandate debit lifecycle', () => {
  it('happy path: begin -> submitted -> succeeded -> paid, and event replays change nothing', async () => {
    const f = await makeFixture();
    const attempt = await startAndSubmit(f, 'pay_happy');
    expect(attempt.amountPaise).toBe(1_000_000);
    expect(attempt.idempotencyKey).toBe(`${f.cycleId}:mandate:1`);
    expect((await cycleRow(f.cycleId)).status).toBe('processing');

    const first = await service.handlePaymentSucceeded({
      providerRef: 'pay_happy',
    });
    expect(first).toMatchObject({ applied: true, cycleStatus: 'paid' });
    const replay = await service.handlePaymentSucceeded({
      providerRef: 'pay_happy',
    });
    expect(replay.applied).toBe(false);

    expect(await ledgerCount(f.cycleId, 'payment')).toBe(1);
    expect(await service.getCycleBalance(f.cycleId)).toBe(0);
    expect((await cycleRow(f.cycleId)).status).toBe('paid');
  });

  it('applies a success event exactly once under concurrent duplicates', async () => {
    const f = await makeFixture();
    await startAndSubmit(f, 'pay_dupes');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.handlePaymentSucceeded({ providerRef: 'pay_dupes' }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await ledgerCount(f.cycleId, 'payment')).toBe(1);
    expect(await service.getCycleBalance(f.cycleId)).toBe(0);
  });

  it('allows only one concurrent debit attempt per cycle', async () => {
    const f = await makeFixture();
    const settled = await Promise.allSettled([
      service.beginDebitAttempt(f.cycleId),
      service.beginDebitAttempt(f.cycleId),
      service.beginDebitAttempt(f.cycleId),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM payments WHERE rent_cycle_id = $1`,
        [f.cycleId],
      ),
    ).toBe(1);
  });

  it('refuses a debit when preconditions are not met', async () => {
    await expect(
      service.beginDebitAttempt(
        (await makeFixture({ mandate: false })).cycleId,
      ),
    ).rejects.toThrow(/No active test mandate/);
    await expect(
      service.beginDebitAttempt(
        (await makeFixture({ mandateEnv: 'live' })).cycleId,
      ),
    ).rejects.toThrow(/No active test mandate/);
    await expect(
      service.beginDebitAttempt(
        (await makeFixture({ maxAmountPaise: 500_000 })).cycleId,
      ),
    ).rejects.toThrow(/exceeds the mandate maximum/);
    await expect(
      service.beginDebitAttempt(
        (await makeFixture({ collectionMode: 'manual' })).cycleId,
      ),
    ).rejects.toThrow(/not active for auto-debit/);
  });

  it('retries after bank failures, then goes overdue when the window is exhausted', async () => {
    const f = await makeFixture({ retryDays: 2 }); // 1 attempt + 2 retries = 3 attempts

    await startAndSubmit(f, 'pay_r1');
    const o1 = await service.handlePaymentFailed(
      { providerRef: 'pay_r1' },
      'INSUFFICIENT_FUNDS',
    );
    expect(o1.cycleStatus).toBe('retry_wait');
    const afterFirst = await cycleRow(f.cycleId);
    expect(afterFirst.next_attempt_at?.toISOString()).toBe(
      '2026-11-30T05:00:00.000Z',
    );

    await startAndSubmit(f, 'pay_r2');
    // a failure with no code must still count as a used attempt
    const o2 = await service.handlePaymentFailed(
      { providerRef: 'pay_r2' },
      null,
    );
    expect(o2.cycleStatus).toBe('retry_wait');

    const third = await startAndSubmit(f, 'pay_r3');
    expect(third.attemptNo).toBe(3);
    const o3 = await service.handlePaymentFailed(
      { providerRef: 'pay_r3' },
      'INSUFFICIENT_FUNDS',
    );
    expect(o3.cycleStatus).toBe('overdue');
    expect((await cycleRow(f.cycleId)).next_attempt_at).toBeNull();

    await expect(service.beginDebitAttempt(f.cycleId)).rejects.toThrow(
      ConflictException,
    );
    expect(await service.getCycleBalance(f.cycleId)).toBe(1_000_000); // nothing was collected
  });

  it('does not use up a retry when the provider rejects the request outright', async () => {
    const f = await makeFixture({ retryDays: 0 }); // exactly one bank attempt allowed
    const rejected = await service.beginDebitAttempt(f.cycleId);
    await service.abandonAttempt(rejected.paymentId);
    expect((await cycleRow(f.cycleId)).status).toBe('upcoming');

    const second = await service.beginDebitAttempt(f.cycleId);
    expect(second.attemptNo).toBe(2);
    await service.markSubmitted(second.paymentId, 'pay_after_reject');
    const outcome = await service.handlePaymentFailed(
      { providerRef: 'pay_after_reject' },
      'X',
    );
    expect(outcome.cycleStatus).toBe('overdue');
  });

  it('handles a success event that arrives before markSubmitted (maps by idempotency key)', async () => {
    const f = await makeFixture();
    const attempt = await service.beginDebitAttempt(f.cycleId);
    const outcome = await service.handlePaymentSucceeded({
      providerRef: 'pay_early',
      idempotencyKey: attempt.idempotencyKey,
    });
    expect(outcome).toMatchObject({ applied: true, cycleStatus: 'paid' });
    const [p] = await rows<{ provider_ref: string; status: string }>(
      `SELECT provider_ref, status FROM payments WHERE id = $1`,
      [attempt.paymentId],
    );
    expect(p).toEqual({ provider_ref: 'pay_early', status: 'succeeded' });
    // the late markSubmitted call is now a conflict, not a corruption
    await expect(
      service.markSubmitted(attempt.paymentId, 'pay_early'),
    ).rejects.toThrow(ConflictException);
  });

  it('handles a failure event that arrives before markSubmitted', async () => {
    const f = await makeFixture();
    const attempt = await service.beginDebitAttempt(f.cycleId);
    const outcome = await service.handlePaymentFailed(
      { providerRef: 'pay_early_fail', idempotencyKey: attempt.idempotencyKey },
      'INSUFFICIENT_FUNDS',
    );
    expect(outcome.cycleStatus).toBe('retry_wait');
  });

  it('markSubmitted is idempotent for the same provider reference', async () => {
    const f = await makeFixture();
    const attempt = await service.beginDebitAttempt(f.cycleId);
    await service.markSubmitted(attempt.paymentId, 'pay_same');
    await service.markSubmitted(attempt.paymentId, 'pay_same');
    await expect(
      service.markSubmitted(attempt.paymentId, 'pay_other'),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects events for unknown payments', async () => {
    await expect(
      service.handlePaymentSucceeded({ providerRef: 'pay_does_not_exist' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('flags contradictory events for a human instead of applying them', async () => {
    const f = await makeFixture({ retryDays: 3 });
    await startAndSubmit(f, 'pay_fail_then_ok');
    await service.handlePaymentFailed({ providerRef: 'pay_fail_then_ok' }, 'X');
    const late = await service.handlePaymentSucceeded({
      providerRef: 'pay_fail_then_ok',
    });
    expect(late.applied).toBe(false);
    expect(await discrepancies(f.cycleId, 'success_after_failure')).toBe(1);
    expect(await ledgerCount(f.cycleId, 'payment')).toBe(0);

    const g = await makeFixture();
    await startAndSubmit(g, 'pay_ok_then_fail');
    await service.handlePaymentSucceeded({ providerRef: 'pay_ok_then_fail' });
    const contradict = await service.handlePaymentFailed(
      { providerRef: 'pay_ok_then_fail' },
      'X',
    );
    expect(contradict.applied).toBe(false);
    expect(await discrepancies(g.cycleId, 'failure_after_success')).toBe(1);
    expect((await cycleRow(g.cycleId)).status).toBe('paid');
  });
});

describe('cash payments', () => {
  it('owner records, tenant confirms: partial then full', async () => {
    const f = await makeFixture({ due: true });
    const owner = { id: f.ownerId, role: 'owner' as const };
    const tenant = { id: f.tenantId, role: 'tenant' as const };

    const part = await service.recordCash(f.cycleId, 400_000, owner);
    expect(await ledgerCount(f.cycleId, 'payment')).toBe(0); // not credited until confirmed
    const confirmed = await service.confirmCash(part.paymentId, tenant);
    expect(confirmed).toMatchObject({
      applied: true,
      cycleStatus: 'partially_paid',
    });
    expect(await service.getCycleBalance(f.cycleId)).toBe(600_000);

    // confirming twice is a no-op
    expect((await service.confirmCash(part.paymentId, tenant)).applied).toBe(
      false,
    );
    expect(await ledgerCount(f.cycleId, 'payment')).toBe(1);

    const rest = await service.recordCash(f.cycleId, 600_000, owner);
    const done = await service.confirmCash(rest.paymentId, tenant);
    expect(done.cycleStatus).toBe('paid');
    expect(await service.getCycleBalance(f.cycleId)).toBe(0);
  });

  it('enforces who may record, confirm and dispute', async () => {
    const f = await makeFixture({ due: true });
    const other = await makeFixture({ due: true });
    const owner = { id: f.ownerId, role: 'owner' as const };
    const tenant = { id: f.tenantId, role: 'tenant' as const };

    await expect(
      service.recordCash(f.cycleId, 100_000, tenant),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.recordCash(f.cycleId, 100_000, {
        id: other.ownerId,
        role: 'owner',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.recordCash(f.cycleId, 2_000_000, owner),
    ).rejects.toThrow(BadRequestException);

    const rec = await service.recordCash(f.cycleId, 100_000, owner);
    await expect(service.confirmCash(rec.paymentId, owner)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.confirmCash(rec.paymentId, {
        id: other.tenantId,
        role: 'tenant',
      }),
    ).rejects.toThrow(ForbiddenException);

    await service.disputeCash(rec.paymentId, tenant);
    await expect(service.confirmCash(rec.paymentId, tenant)).rejects.toThrow(
      /disputed/,
    );
    expect(await ledgerCount(f.cycleId, 'payment')).toBe(0);
  });

  it('refuses cash on a cycle that is not yet due', async () => {
    const f = await makeFixture(); // still 'upcoming'
    await expect(
      service.recordCash(f.cycleId, 100_000, { id: f.ownerId, role: 'owner' }),
    ).rejects.toThrow(ConflictException);
  });

  it('flags an overpayment when cash and a debit both succeed, and never changes the closed cycle', async () => {
    const f = await makeFixture();
    await startAndSubmit(f, 'pay_overlap'); // cycle is now processing
    const rec = await service.recordCash(f.cycleId, 1_000_000, {
      id: f.ownerId,
      role: 'owner',
    });
    await service.confirmCash(rec.paymentId, {
      id: f.tenantId,
      role: 'tenant',
    });
    expect((await cycleRow(f.cycleId)).status).toBe('paid');

    const debit = await service.handlePaymentSucceeded({
      providerRef: 'pay_overlap',
    });
    expect(debit.cycleStatus).toBe('paid');
    expect(await service.getCycleBalance(f.cycleId)).toBe(-1_000_000);
    expect(await discrepancies(f.cycleId, 'overpayment')).toBe(1);
  });
});

describe('money types', () => {
  it('returns balances as numbers, not strings', async () => {
    const f = await makeFixture();
    expect(typeof (await service.getCycleBalance(f.cycleId))).toBe('number');
    const [p] = await rows<{ amount_paise: string }>(
      `SELECT amount_due_paise::text AS amount_paise FROM rent_cycles WHERE id = $1`,
      [f.cycleId],
    );
    expect(p.amount_paise).toBe('1000000');
  });
});
