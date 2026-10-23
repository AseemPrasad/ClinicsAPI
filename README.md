# Clinics API

REST API foundation for clinic appointment slots and patient bookings.

## Technology

- Node.js 20+
- TypeScript with strict compiler checks
- Fastify
- PostgreSQL 16
- Prisma
- Zod
- Vitest
- ESLint and Prettier

## Local setup

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL:

   ```sh
   docker compose up -d postgres
   ```

3. Install dependencies:

   ```sh
   npm install
   ```

4. Generate the Prisma client and apply migrations:

   ```sh
   npm run prisma:generate
   npm run prisma:migrate
   ```

5. Start the development server:

   ```sh
   npm run dev
   ```

The health endpoint is available at `GET /health`.

## Slot API

The slot endpoints are:

- `POST /clinics/:clinicId/slots` creates a future slot. Timestamps must be ISO 8601 values with an explicit timezone.
- `GET /clinics/:clinicId/slots` lists slots using `from`, `to`, `status`, `availability`, `page`, and `limit` query parameters. Results are ordered by start time and ID and use page/limit pagination.
- `GET /slots/:slotId` retrieves a slot.
- `DELETE /slots/:slotId` cancels a slot. Cancellation is idempotent; a slot with a confirmed booking returns `409 SLOT_HAS_CONFIRMED_BOOKING`.

Slot retrieval and listing expose `availability` (`available`, `booked`, or `cancelled`) but do not expose booking or patient details. Availability is derived from confirmed bookings, so cancelled bookings do not reserve a slot.

## Booking API

The booking endpoints are:

- `POST /slots/:slotId/bookings` books a future, non-cancelled slot for a UUID `patientId`.
- `GET /bookings/:bookingId` retrieves booking history, including cancelled bookings.
- `DELETE /bookings/:bookingId` cancels a confirmed booking. Repeating cancellation is idempotent and returns the existing cancelled booking.

Booking uses one PostgreSQL transaction that locks the slot row with `SELECT ... FOR UPDATE`, validates mutable slot state, checks for a confirmed booking, and inserts the booking. The `one_active_booking_per_slot` partial unique index remains the final database-level guarantee. Its specific Prisma unique violation is translated to `409 SLOT_ALREADY_BOOKED`; unrelated database failures remain internal errors.

Booking cancellation acquires the slot lock before changing the booking. This is the same lock order used by slot cancellation, so booking/cancellation races serialize deterministically. If booking wins, slot cancellation returns `409 SLOT_HAS_CONFIRMED_BOOKING`; if slot cancellation wins, booking returns `409 SLOT_CANCELLED`.

The supplied patient identifier is validated as a UUID but is not authenticated identity. Authentication and authorization remain outside the current scope.

## Database design

The initial migration creates clinics, appointment slots, and bookings. A PostgreSQL partial unique index named `one_active_booking_per_slot` guarantees that a slot cannot have more than one confirmed booking. Cancelled bookings are retained and do not participate in that index.

The partial index is intentionally defined in `prisma/migrations/20261023130000_init/migration.sql` because Prisma schema syntax does not represent this conditional uniqueness constraint directly. Future migrations must preserve an equivalent database constraint.

Authentication and authorization are outside the initial implementation. Identifiers supplied by callers are not treated as proof of authorization.

## Quality checks

```sh
npm run prisma:validate
npm run typecheck
npm run lint
npm run format:check
npm test
```

## PostgreSQL integration tests

The repository includes a separate PostgreSQL-only suite at
`tests/integration/postgres.test.ts`. It requires `DATABASE_URL` to point to a
dedicated database whose name contains `test` (for example,
`clinics_test`). The suite refuses to run against a database with another name
and never performs cleanup unless this guard passes.

Apply migrations and run the suite with:

```sh
$env:DATABASE_URL = "postgresql://clinics:clinics@localhost:5432/clinics_test?schema=public"
npm run test:postgres
```

The suite uses real Fastify injection requests against the Prisma repository,
real PostgreSQL transactions, row locks, and the partial unique index. It
asserts persisted state after concurrent booking and cancellation races.
