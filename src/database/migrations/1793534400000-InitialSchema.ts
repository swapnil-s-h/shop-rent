import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema. Hand-written SQL on purpose: partial unique indexes, the
 * EXCLUDE constraint, state-transition triggers and the append-only ledger are
 * what keep payment data correct, and generated migrations can't express them.
 * Tested against PostgreSQL 16.
 */
export class InitialSchema1793534400000 implements MigrationInterface {
  name = 'InitialSchema1793534400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(DOWN_SQL);
  }
}

const UP_SQL = `
-- ============================================================
-- Shop Rent: initial schema
-- Money is BIGINT paise everywhere. Status/type columns are TEXT + CHECK
-- (easier to evolve than Postgres enums).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- generic helper functions ----------

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- Usage: EXECUTE FUNCTION assert_user_role('<column>', '<role>')
CREATE FUNCTION assert_user_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid AND role = TG_ARGV[1]) THEN
    RAISE EXCEPTION '%.% must reference a user with role %', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------- users ----------

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role         text NOT NULL CHECK (role IN ('tenant', 'owner', 'admin')),
  phone        text NOT NULL UNIQUE CHECK (phone ~ '^[+]91[6-9][0-9]{9}$'),
  firebase_uid text UNIQUE,
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- shops ----------

CREATE TABLE shops (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users (id),
  label      text NOT NULL CHECK (length(btrim(label)) > 0),
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, label),
  UNIQUE (id, owner_id)
);

CREATE TRIGGER shops_owner_role BEFORE INSERT OR UPDATE OF owner_id ON shops
  FOR EACH ROW EXECUTE FUNCTION assert_user_role('owner_id', 'owner');

-- ---------- leases ----------

CREATE TABLE leases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL,
  owner_id        uuid NOT NULL,
  tenant_id       uuid NOT NULL REFERENCES users (id),
  start_date      date NOT NULL,
  end_date        date,
  deposit_paise   bigint NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  due_rule        text NOT NULL DEFAULT 'month_end' CHECK (due_rule IN ('month_end', 'day_of_month')),
  due_day         smallint,
  grace_days      smallint NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 30),
  retry_days      smallint NOT NULL DEFAULT 5 CHECK (retry_days BETWEEN 0 AND 30),
  collection_mode text NOT NULL DEFAULT 'auto_debit' CHECK (collection_mode IN ('auto_debit', 'manual')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- shop must belong to the same owner as the lease
  FOREIGN KEY (shop_id, owner_id) REFERENCES shops (id, owner_id),
  UNIQUE (id, owner_id),
  CONSTRAINT leases_dates_ok CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT leases_due_rule_ok CHECK (
    (due_rule = 'month_end' AND due_day IS NULL)
    OR (due_rule = 'day_of_month' AND due_day IS NOT NULL AND due_day BETWEEN 1 AND 31)
  ),
  -- at most one active lease per shop for any date range
  CONSTRAINT leases_no_overlapping_active EXCLUDE USING gist (
    shop_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status = 'active')
);

CREATE INDEX leases_tenant_idx ON leases (tenant_id);
CREATE INDEX leases_owner_status_idx ON leases (owner_id, status);

CREATE TRIGGER leases_tenant_role BEFORE INSERT OR UPDATE OF tenant_id ON leases
  FOR EACH ROW EXECUTE FUNCTION assert_user_role('tenant_id', 'tenant');

CREATE TABLE lease_rent_terms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id       uuid NOT NULL REFERENCES leases (id),
  effective_from date NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, effective_from)
);

-- ---------- mandates ----------

CREATE TABLE mandates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid NOT NULL REFERENCES leases (id),
  provider            text NOT NULL DEFAULT 'razorpay',
  env                 text NOT NULL CHECK (env IN ('test', 'live')),
  provider_customer_id text,
  provider_token_id   text,
  max_amount_paise    bigint NOT NULL CHECK (max_amount_paise > 0),
  valid_from          date,
  valid_to            date,
  status              text NOT NULL DEFAULT 'pending_auth'
    CHECK (status IN ('pending_auth', 'active', 'paused', 'cancelled', 'failed', 'expired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandates_validity_ok CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

-- one live-ish mandate per lease
CREATE UNIQUE INDEX mandates_one_open_per_lease
  ON mandates (lease_id) WHERE status IN ('pending_auth', 'active', 'paused');
CREATE UNIQUE INDEX mandates_provider_token_unique
  ON mandates (provider, env, provider_token_id) WHERE provider_token_id IS NOT NULL;

-- ---------- rent cycles ----------

CREATE TABLE rent_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id              uuid NOT NULL REFERENCES leases (id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  due_date              date NOT NULL,
  amount_due_paise      bigint NOT NULL CHECK (amount_due_paise > 0),   -- snapshot, never recomputed
  status                text NOT NULL DEFAULT 'upcoming' CHECK (status IN
    ('upcoming', 'due', 'processing', 'retry_wait', 'overdue', 'partially_paid', 'paid', 'waived', 'cancelled')),
  next_attempt_at       timestamptz,
  pre_debit_notified_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, period_start),
  UNIQUE (id, lease_id),
  CONSTRAINT rent_cycles_period_ok CHECK (period_end >= period_start)
);

CREATE INDEX rent_cycles_status_due_idx ON rent_cycles (status, due_date);
CREATE INDEX rent_cycles_next_attempt_idx ON rent_cycles (next_attempt_at)
  WHERE status IN ('due', 'retry_wait', 'upcoming');

-- Allowed status transitions (the DB enforces this, not just the app)
CREATE TABLE rent_cycle_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO rent_cycle_transitions (from_status, to_status) VALUES
  ('upcoming', 'due'),
  ('upcoming', 'processing'),        -- auto-debit is initiated ahead of the due date (pre-debit notice lead time)
  ('due', 'processing'),
  ('processing', 'paid'),
  ('processing', 'retry_wait'),
  ('retry_wait', 'processing'),
  ('processing', 'overdue'),
  ('due', 'overdue'),                -- manual-collection leases / no mandate
  ('retry_wait', 'overdue'),
  ('due', 'paid'),
  ('retry_wait', 'paid'),
  ('overdue', 'paid'),               -- late success is always accepted
  ('partially_paid', 'paid'),
  ('due', 'partially_paid'),
  ('processing', 'partially_paid'),
  ('retry_wait', 'partially_paid'),
  ('overdue', 'partially_paid');

INSERT INTO rent_cycle_transitions (from_status, to_status)
SELECT s, t
FROM unnest(ARRAY['upcoming', 'due', 'processing', 'retry_wait', 'overdue', 'partially_paid']) AS s
CROSS JOIN unnest(ARRAY['waived', 'cancelled']) AS t;

CREATE TRIGGER rent_cycle_transitions_readonly BEFORE UPDATE OR DELETE ON rent_cycle_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION enforce_rent_cycle_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM rent_cycle_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'illegal rent_cycle transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.lease_id <> OLD.lease_id
     OR NEW.period_start <> OLD.period_start
     OR NEW.period_end <> OLD.period_end
     OR NEW.amount_due_paise <> OLD.amount_due_paise
     OR (NEW.due_date <> OLD.due_date AND OLD.status <> 'upcoming') THEN
    RAISE EXCEPTION 'rent_cycle snapshot fields are immutable (amount, period, lease; due_date only while upcoming)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rent_cycles_rules BEFORE UPDATE ON rent_cycles
  FOR EACH ROW EXECUTE FUNCTION enforce_rent_cycle_rules();

-- ---------- payments ----------

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_cycle_id   uuid NOT NULL REFERENCES rent_cycles (id),
  method          text NOT NULL CHECK (method IN ('mandate', 'pay_link', 'cash')),
  attempt_no      integer NOT NULL CHECK (attempt_no >= 1),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  status          text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'submitted', 'succeeded', 'failed', 'reversed')),
  idempotency_key text NOT NULL UNIQUE,
  provider_ref    text,
  failure_code    text,
  recorded_by     uuid REFERENCES users (id),   -- cash: who recorded it
  confirmed_by    uuid REFERENCES users (id),   -- cash: who confirmed it
  disputed_at     timestamptz,                  -- cash: tenant disputed
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rent_cycle_id, method, attempt_no),
  UNIQUE (id, rent_cycle_id),
  CONSTRAINT payments_cash_recorded CHECK (method <> 'cash' OR recorded_by IS NOT NULL),
  CONSTRAINT payments_cash_confirmed CHECK (method <> 'cash' OR status <> 'succeeded' OR confirmed_by IS NOT NULL),
  CONSTRAINT payments_provider_ref_needed CHECK (method = 'cash' OR status IN ('created', 'failed') OR provider_ref IS NOT NULL)
);

-- At most ONE in-flight online payment per rent cycle (cash awaiting confirmation does not block)
CREATE UNIQUE INDEX payments_one_inflight_per_cycle
  ON payments (rent_cycle_id)
  WHERE method IN ('mandate', 'pay_link') AND status IN ('created', 'submitted');

CREATE UNIQUE INDEX payments_provider_ref_unique ON payments (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_inflight_idx ON payments (status, updated_at) WHERE status IN ('created', 'submitted');

CREATE FUNCTION enforce_payment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('created', 'submitted'), ('created', 'succeeded'), ('created', 'failed'),
    ('submitted', 'succeeded'), ('submitted', 'failed'), ('succeeded', 'reversed')
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.amount_paise <> OLD.amount_paise OR NEW.rent_cycle_id <> OLD.rent_cycle_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.method <> OLD.method THEN
    RAISE EXCEPTION 'payment amount, cycle, method and idempotency key are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_rules BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_transition();

-- ---------- ledger (append-only) ----------
-- Sign convention: charge/late_fee/refund > 0 (tenant owes), payment/waiver < 0, adjustment either.
-- Cycle balance = SUM(amount_paise). <= 0 means fully paid.

CREATE TABLE ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id      uuid NOT NULL,
  rent_cycle_id uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('charge', 'payment', 'late_fee', 'waiver', 'adjustment', 'refund')),
  amount_paise  bigint NOT NULL CHECK (amount_paise <> 0),
  payment_id    uuid,
  reason        text,
  created_by    uuid REFERENCES users (id),   -- NULL = system/job
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rent_cycle_id, lease_id) REFERENCES rent_cycles (id, lease_id),
  FOREIGN KEY (payment_id, rent_cycle_id) REFERENCES payments (id, rent_cycle_id),
  CONSTRAINT ledger_sign_ok CHECK (
    (type IN ('charge', 'late_fee', 'refund') AND amount_paise > 0)
    OR (type IN ('payment', 'waiver') AND amount_paise < 0)
    OR type = 'adjustment'
  ),
  CONSTRAINT ledger_payment_ref_ok CHECK ((type IN ('payment', 'refund')) = (payment_id IS NOT NULL)),
  CONSTRAINT ledger_reason_ok CHECK (
    type NOT IN ('waiver', 'adjustment', 'late_fee', 'refund') OR length(btrim(coalesce(reason, ''))) > 0
  ),
  CONSTRAINT ledger_actor_ok CHECK (type NOT IN ('waiver', 'adjustment') OR created_by IS NOT NULL)
);

CREATE INDEX ledger_cycle_idx ON ledger_entries (rent_cycle_id);
CREATE INDEX ledger_lease_idx ON ledger_entries (lease_id, created_at);
-- exactly one charge per cycle; a payment can be credited to the ledger only once
CREATE UNIQUE INDEX ledger_one_charge_per_cycle ON ledger_entries (rent_cycle_id) WHERE type = 'charge';
CREATE UNIQUE INDEX ledger_one_credit_per_payment ON ledger_entries (payment_id) WHERE type = 'payment';

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE VIEW rent_cycle_balances AS
  SELECT rent_cycle_id, SUM(amount_paise)::bigint AS balance_paise
  FROM ledger_entries
  GROUP BY rent_cycle_id;

-- ---------- webhooks ----------

CREATE TABLE webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text,
  payload           jsonb NOT NULL,
  signature_valid   boolean NOT NULL,
  status            text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  error             text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);

-- Dedupe ONLY events with a valid signature, so a forged event can never "claim" a real event id.
CREATE UNIQUE INDEX webhook_events_dedupe
  ON webhook_events (provider, provider_event_id) WHERE signature_valid;
CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at) WHERE status IN ('received', 'failed');

-- ---------- audit log (append-only) ----------

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES users (id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, created_at);

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------- support tables ----------

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  fcm_token    text NOT NULL UNIQUE,
  platform     text NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  channel     text NOT NULL CHECK (channel IN ('push', 'email', 'in_app')),
  template    text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  dedupe_key  text NOT NULL UNIQUE,          -- e.g. 'cycle:<id>:overdue:tenant' => never sent twice
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  send_after  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_outbox_pending_idx ON notification_outbox (send_after) WHERE status = 'pending';

CREATE TABLE reconciliation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date    date NOT NULL UNIQUE,          -- the day being reconciled
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'discrepancies', 'failed')),
  summary     jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE discrepancies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES reconciliation_runs (id),
  kind          text NOT NULL,
  rent_cycle_id uuid REFERENCES rent_cycles (id),
  payment_id    uuid REFERENCES payments (id),
  details       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by   uuid REFERENCES users (id),
  resolved_note text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discrepancies_resolved_ok CHECK (
    status = 'open' OR (resolved_by IS NOT NULL AND length(btrim(coalesce(resolved_note, ''))) > 0)
  )
);

-- ---------- updated_at triggers ----------

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shops_updated_at BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leases_updated_at BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mandates_updated_at BEFORE UPDATE ON mandates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rent_cycles_updated_at BEFORE UPDATE ON rent_cycles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

const DOWN_SQL = `
DROP VIEW IF EXISTS rent_cycle_balances;
DROP TABLE IF EXISTS discrepancies, reconciliation_runs, notification_outbox, devices,
  audit_log, webhook_events, ledger_entries, payments, rent_cycle_transitions,
  rent_cycles, mandates, lease_rent_terms, leases, shops, users CASCADE;
DROP FUNCTION IF EXISTS enforce_payment_transition();
DROP FUNCTION IF EXISTS enforce_rent_cycle_rules();
DROP FUNCTION IF EXISTS assert_user_role();
DROP FUNCTION IF EXISTS forbid_mutation();
DROP FUNCTION IF EXISTS set_updated_at();
`;
