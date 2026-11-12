# Shop Rent Management System

A mobile-first rent management platform for property owners who rent out multiple shops. It replaces cash collection and manual tracking with recorded leases, automatic monthly rent collection from tenants' bank accounts, and a clear view of who has paid and who is pending.

This repository contains the **backend API** (NestJS). The mobile app and any admin tooling will be built separately.

## Overview

Rent is currently collected in cash every month, which makes it hard to know who has paid and who is still pending. This system lets an owner manage shops, tenants and leases in one place, and collects rent automatically through a bank mandate (e-NACH), with a manual cash-recording fallback.

The initial deployment serves **one owner with approximately 20–25 shops**, where monthly rent per shop is ₹10,000 or less. The product is scoped to India (INR, e-NACH).

> **Project status:** Early development. The repository setup, CI quality checks, environment configuration, the initial database schema, TypeORM entities and the core payment service (ledger, rent-cycle state handling, debit lifecycle and cash confirmation) are in place and covered by integration tests. HTTP APIs, authentication, the Razorpay adapter and background jobs are not implemented yet.

## Roles

| Role     | Description                                                                        |
| -------- | ---------------------------------------------------------------------------------- |
| `tenant` | Rents a shop. Views their lease and rent history, sets up the bank mandate, pays.  |
| `owner`  | Receives the rent. Manages shops and leases and sees who has paid and who is late. |
| `admin`  | Platform administrator (the developer). Read-only overview of all owners and data. |

Each user has exactly one role. Accounts are created by invitation: an owner invites tenants by phone number, and an admin creates the owner account. There is no open self-signup.

## Planned Features

The following capabilities are part of the planned scope and should not be interpreted as already implemented functionality.

- **Shop Management:** Register and maintain rental shops.
- **Tenant and Lease Management:** Associate tenants with shops through leases (rent amount, deposit, start/end dates, escalations, due date, grace and retry settings).
- **Phone OTP Login:** Sign-in with a phone number verified through Firebase Authentication.
- **Automatic Rent Collection:** Monthly auto-debit from the tenant's bank account through e-NACH. The default debit date is the end of the month; the owner can configure a custom date per lease.
- **Failed Debit Handling:** Automatic retries within a configurable window when a debit fails (for example, insufficient funds), plus a "Pay now" fallback link for the tenant.
- **Rent Tracking:** A clear view of paid, processing, pending and overdue rent for each month.
- **Manual Cash Entry:** The owner records cash payments and the tenant confirms them, so tracking stays complete for tenants who do not use auto-debit.
- **Receipts and Notifications:** PDF receipts, plus push, in-app and email notifications.
- **Late Fees and Rent Escalation:** Supported by the ledger; configurable per lease.
- **Audit Log and Reconciliation:** Every sensitive change is recorded, and ledger data is reconciled daily against the payment provider's reports.

## Technology Stack

Items marked _(planned)_ are decided but not yet implemented.

| Area                      | Technology                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| Backend Framework         | NestJS (modular monolith)                                            |
| Programming Language      | TypeScript                                                           |
| Runtime                   | Node.js                                                              |
| Package Manager           | npm                                                                  |
| Database                  | PostgreSQL                                                           |
| ORM and Migrations        | TypeORM, with hand-written SQL migrations                            |
| Configuration             | @nestjs/config with zod validation                                   |
| Background Jobs           | pg-boss, a Postgres-backed job queue _(planned)_                     |
| Payments                  | Razorpay e-NACH (bank mandate auto-debit) _(planned)_                |
| Authentication            | Firebase Authentication (phone OTP) + backend-issued JWT _(planned)_ |
| Push Notifications        | Firebase Cloud Messaging _(planned)_                                 |
| Mobile App                | React Native with Expo _(planned, separate repository)_              |
| Code Quality              | ESLint                                                               |
| Code Formatting           | Prettier                                                             |
| Unit Testing              | Jest                                                                 |
| Git Hooks                 | Husky                                                                |
| Staged File Checks        | lint-staged                                                          |
| Commit Message Convention | Conventional Commits                                                 |
| CI/CD Platform            | GitHub Actions                                                       |

The technology stack may evolve as application development progresses.

## Architecture

The backend is a **modular monolith**: one deployable NestJS application with clearly separated modules. Payments need strong consistency, so a single database and a single deployable are easier to make correct than distributed services.

Planned modules under `src/`:

| Module           | Responsibility                                                              |
| ---------------- | --------------------------------------------------------------------------- |
| `auth`           | Firebase token exchange, JWT sessions, role guards                          |
| `users`          | User accounts and roles                                                     |
| `shops`          | Shops owned by the owner                                                    |
| `leases`         | Leases, rent terms (escalations), due-date settings                         |
| `mandates`       | Bank mandate lifecycle                                                      |
| `rent-cycles`    | Monthly rent cycles and read models                                         |
| `payments`       | The only writer of payments, ledger entries and rent-cycle status           |
| `providers`      | Payment-provider interface and the Razorpay adapter                         |
| `webhooks`       | Signature-verified webhook intake                                           |
| `jobs`           | Scheduled jobs (cycle generation, debits, retries, polling, reconciliation) |
| `notifications`  | Outbox-based push, in-app and email notifications                           |
| `receipts`       | PDF receipt generation                                                      |
| `reconciliation` | Daily comparison of the ledger against provider reports                     |
| `audit`          | Audit log writer                                                            |
| `config`         | Typed, validated environment configuration                                  |
| `database`       | TypeORM data source and migrations                                          |
| `common`         | Shared guards, decorators and utilities                                     |

Two boundaries are intended to be enforced as the code grows: only the `payments` module may write to the ledger and payment tables, and only the `providers` module may use the Razorpay SDK.

## Payments Design

Rent collection is the most sensitive part of the system. The following decisions guide the design:

- **e-NACH for auto-debit.** The tenant authorizes a bank mandate once. Unlike UPI Autopay, it cannot be cancelled with a tap in an app; cancelling goes through the bank. No mandate is truly uncancellable, so mandate status changes are monitored and the owner is alerted.
- **The owner's own Razorpay account.** Tenant debits settle directly into the owner's bank account. The platform never holds or moves money and is not a payment aggregator. During development a test-mode Razorpay account is used; live keys are only used in production with the owner's account.
- **No real-time "debit when funds arrive".** Banks do not provide that signal. Failed debits are retried automatically within a configurable window, and the tenant can pay immediately through a one-time payment link.
- **Pre-debit notification is handled by Razorpay and the bank.** For e-NACH debits created without an explicit notification object, Razorpay triggers the debit 25 hours after the pre-debit notification is delivered, so debits are initiated about a day before the due date. Confirm the exact behaviour against the current Razorpay documentation.
- **Webhooks are the source of truth.** A payment is marked successful only from a signature-verified provider webhook, never from a client response.
- **Idempotency everywhere.** Unique keys per rent cycle and attempt, deduplicated webhook events, and a single in-flight online payment per cycle prevent double charges and double credits.
- **Append-only ledger.** Money movements are recorded as immutable ledger entries. Corrections are new entries, and cycle status is derived from the ledger.
- **Rent-cycle state machine.** Allowed status transitions are enforced in application code and by the database.
- **Money as integers.** All amounts are stored as integer paise, never floating-point values.
- **Daily reconciliation** between the ledger and the provider's settlement data.

## Authentication

Phone OTP login uses **Firebase Authentication**, which avoids the DLT sender registration required to send OTP SMS directly in India. Firebase only proves ownership of a phone number: the mobile app sends the Firebase ID token to the backend, which verifies it with the Firebase Admin SDK and issues its own access and refresh JWTs containing the user's role. Only phone numbers that already exist in the system can sign in.

## Database

PostgreSQL is the system of record. The schema is managed exclusively through TypeORM migrations (`synchronize` is permanently disabled). The initial migration is hand-written SQL because the following guarantees cannot be expressed in generated migrations:

- Partial unique indexes (for example, one in-flight online payment per rent cycle).
- An exclusion constraint preventing overlapping active leases for the same shop.
- Triggers enforcing allowed state transitions on rent cycles and payments.
- Append-only protection for the ledger and audit log.

Core tables: `users`, `shops`, `leases`, `lease_rent_terms`, `mandates`, `rent_cycles`, `payments`, `ledger_entries`, `webhook_events` and `audit_log`, plus supporting tables for devices, notifications and reconciliation.

## Prerequisites

Ensure the following tools are installed:

- [Node.js](https://nodejs.org/) — version `24.22.2`
- [npm](https://www.npmjs.com/)
- [Git](https://git-scm.com/)
- [PostgreSQL](https://www.postgresql.org/) — the migration was tested on version 16

The repository includes an `.nvmrc` file to specify the intended Node.js version.

If you use NVM, switch to the project version with:

```bash
nvm install
nvm use
```

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/swapnil-s-h/shop-rent.git
cd shop-rent
```

### 2. Switch to the development branch

```bash
git switch development
```

### 3. Install dependencies

```bash
npm ci
```

`npm ci` installs dependencies using the committed `package-lock.json` to provide a consistent installation.

### 4. Configure environment variables

Create a local `.env` file using `.env.example` as a reference. See [Environment Variables](#environment-variables) for what each value means.

Keep environment-specific values and secrets in your local environment file. Never commit `.env` or other files containing credentials or sensitive information.

### 5. Set up the database

Create the database and apply the migrations:

```bash
createdb shop_rent
npm run migration:run
```

Use `npm run migration:revert` to undo the most recent migration.

### 6. Start the development server

```bash
npm run start:dev
```

The application starts in development mode with file-watching enabled.

## Environment Variables

Environment variables are validated with zod at startup. The application refuses to start if a value is missing or invalid.

| Variable                  | Description                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`                | `development`, `test` or `production`. Defaults to `development`.                   |
| `PORT`                    | HTTP port. Defaults to `3000`.                                                      |
| `DATABASE_URL`            | PostgreSQL connection string.                                                       |
| `JWT_ACCESS_SECRET`       | Secret for access tokens. At least 32 random characters.                            |
| `JWT_REFRESH_SECRET`      | Secret for refresh tokens. At least 32 random characters.                           |
| `PAYMENT_ENV`             | `test` or `live`. Defaults to `test`.                                               |
| `RAZORPAY_KEY_ID`         | Razorpay key ID. Must start with `rzp_test_` or `rzp_live_` to match `PAYMENT_ENV`. |
| `RAZORPAY_KEY_SECRET`     | Razorpay key secret.                                                                |
| `RAZORPAY_WEBHOOK_SECRET` | Secret used to verify Razorpay webhook signatures.                                  |
| `FIREBASE_PROJECT_ID`     | Firebase project ID.                                                                |
| `FIREBASE_CLIENT_EMAIL`   | Firebase service account email.                                                     |
| `FIREBASE_PRIVATE_KEY`    | Firebase service account private key, with newlines written as `\n`.                |

Safety rules enforced at startup:

- `PAYMENT_ENV=live` is only accepted when `NODE_ENV=production`.
- The Razorpay key prefix must match `PAYMENT_ENV`, so test keys can never run in a live deployment and live keys can never run in development.

## Available Scripts

| Command                    | Description                              |
| -------------------------- | ---------------------------------------- |
| `npm run build`            | Build the application                    |
| `npm run start`            | Start the application                    |
| `npm run start:dev`        | Start in development mode with watch     |
| `npm run start:debug`      | Start in debug mode with watch           |
| `npm run start:prod`       | Start the compiled application           |
| `npm run format`           | Format source and test files             |
| `npm run format:check`     | Check formatting without modifying files |
| `npm run lint`             | Run ESLint with automatic fixes          |
| `npm run lint:check`       | Run ESLint without modifying files       |
| `npm run migration:run`    | Apply pending database migrations        |
| `npm run migration:revert` | Revert the most recent migration         |
| `npm test`                 | Run unit tests                           |
| `npm run test:watch`       | Run tests in watch mode                  |
| `npm run test:cov`         | Run tests with coverage                  |
| `npm run test:e2e`         | Run end-to-end tests                     |
| `npm run test:int`         | Run database integration tests           |

For local development, use the formatting and linting commands that automatically fix issues when appropriate. Use the corresponding `:check` commands when you only want to verify the code.

## Testing

- **Unit tests** (`npm test`) need no external services and run in CI.
- **Integration tests** (`npm run test:int`) run the payment service against a real PostgreSQL database and cover concurrency, idempotency and failure cases. They are not part of CI yet.

Integration tests drop and recreate the whole schema, so they use a dedicated database whose name must end with `_test`:

```bash
createdb -U postgres shop_rent_test
DATABASE_URL_TEST=postgres://postgres:abcdefgh@localhost:5432/shop_rent_test npm run test:int
```

The tests refuse to run against any database whose name does not end with `_test`.

## Roadmap

| Phase | Scope                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| 0     | Repository setup, CI, environment configuration, initial database schema (done)                             |
| 1     | Authentication, roles, shops, leases, manual cash tracking and the owner dashboard                          |
| 2     | Mandate onboarding, monthly auto-debit, retries and the "Pay now" fallback (Razorpay test mode, then pilot) |
| 3     | Receipts, reconciliation, late fees, rent escalations and admin screens                                     |

## Repository Structure and Branching Strategy

The repository follows a branch-based development workflow.

| Branch        | Purpose                                  |
| ------------- | ---------------------------------------- |
| `master`      | Production branch                        |
| `development` | Integration and staging branch           |
| `feature/*`   | New feature development                  |
| `fix/*`       | Bug fixes                                |
| `chore/*`     | Maintenance and repository configuration |
| `hotfix/*`    | Urgent production fixes                  |
| `docs/*`      | Documentation                            |
| `test/*`      | Tests                                    |

### Development Workflow

1. Create a new branch from `development` for each task.
2. Implement the changes and validate them locally.
3. Commit changes using Conventional Commits.
4. Push the branch to GitHub.
5. Open a Pull Request targeting `development`.
6. Ensure all required CI checks pass before merging.
7. Changes intended for production are promoted from `development` to `master` through a Pull Request.

Direct pushes to the protected `development` and `master` branches are not part of the normal development workflow.

### Example

Create a feature branch:

```bash
git switch development
git pull origin development
git switch -c feature/shop-management
```

After making changes:

```bash
git add .
git commit -m "feat(shop): add shop management"
git push -u origin feature/shop-management
```

Open a Pull Request from `feature/shop-management` into `development`.

## Commit Message Convention

The repository follows the **Conventional Commits** specification.

Commit messages should follow this format:

```text
<type>(<scope>): <description>
```

Common commit types:

| Type       | Purpose                            |
| ---------- | ---------------------------------- |
| `feat`     | Introduce a new feature            |
| `fix`      | Fix a bug                          |
| `docs`     | Documentation changes              |
| `test`     | Add or update tests                |
| `refactor` | Refactor existing code             |
| `perf`     | Performance improvements           |
| `build`    | Build system or dependency changes |
| `ci`       | CI/CD configuration changes        |
| `chore`    | General maintenance                |

Examples:

```text
feat(shop): add shop registration
fix(tenant): correct tenant validation
test(shop): add shop service unit tests
docs: update project README
ci: add GitHub Actions workflow
chore(repo): update repository configuration
```

Commit messages are validated automatically using Commitlint.

## Code Quality and Git Hooks

The repository uses automated checks to maintain code consistency.

**Husky** manages Git hooks, while **lint-staged** runs checks on staged files before a commit.

The pre-commit hook runs:

- Prettier formatting on staged files.
- ESLint with automatic fixes on staged TypeScript files.

The commit-message hook validates messages against the Conventional Commits specification.

These checks help catch formatting, linting, and commit convention issues before changes enter the repository.

## Continuous Integration

GitHub Actions is configured to run the CI workflow defined in:

```text
.github/workflows/ci.yml
```

The workflow is triggered by:

- Pushes to `development` and `master`.
- Pull Requests targeting `development` and `master`.
- Manual workflow dispatch.

### CI Pipeline

The pipeline performs the following checks:

1. Checks out the repository.
2. Sets up Node.js `24.22.2`.
3. Installs dependencies using `npm ci`.
4. Checks code formatting using Prettier.
5. Runs ESLint.
6. Executes unit tests.
7. Builds the application.

A Pull Request must pass the configured required status checks before it can be merged.

## Security

- Never commit secrets, API keys, passwords, or environment-specific credentials.
- Keep local environment files out of version control.
- Never run real tenant payments through test credentials or a developer's personal payment-provider account. Live keys belong only to the owner's production account.
- Report security vulnerabilities privately rather than through public GitHub issues.

Refer to [SECURITY.md](SECURITY.md) for the security reporting policy.

## Dependency Management

Dependabot is configured to check for dependency updates on a weekly schedule.

It monitors:

- npm dependencies.
- GitHub Actions dependencies.

Dependency updates are submitted as Pull Requests for review.

## License

No license has been specified for this repository yet.
