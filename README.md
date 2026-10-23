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
