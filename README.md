# Clinics API

A small REST API for clinics to publish one-capacity appointment slots and for
patients to book and cancel appointments. The implementation keeps business
rules in services, database access in repositories, and concurrency
correctness in PostgreSQL constraints and transactions.

## Scope

Implemented:

- Clinic slot creation, listing, retrieval, and cancellation.
- Patient booking, booking retrieval, and booking cancellation.
- Input validation and consistent errors.
- PostgreSQL-backed transaction and concurrency guarantees.
- Real PostgreSQL integration tests for locking, partial indexes, rollback, and
  race outcomes.

Authentication and authorization are intentionally outside this assignment.

## Technology stack

- Node.js 20+
- TypeScript with strict compiler checks
- Fastify 5
- PostgreSQL 16
- Prisma 6
- Zod 4
- Vitest 3
- ESLint 9
- Prettier 3
- Docker Compose

## Prerequisites

- Node.js 20 or newer
- npm
- Docker Desktop or another Docker Engine with Compose v2
- PostgreSQL for the application, or the supplied Compose service

## Environment variables

Copy the placeholder file and replace every placeholder:

```powershell
Copy-Item .env.example .env
```

| Variable       | Required | Description                                                       |
| -------------- | -------: | ----------------------------------------------------------------- |
| `NODE_ENV`     |       No | `development`, `test`, or `production`; defaults to `development` |
| `HOST`         |       No | Bind address; defaults to `127.0.0.1`                             |
| `PORT`         |       No | HTTP port; defaults to `3000`                                     |
| `DATABASE_URL` |      Yes | PostgreSQL connection string                                      |

Do not commit `.env`. The checked-in [.env.example](./.env.example) contains
placeholders only.

## Local PostgreSQL

Start the application database:

```powershell
docker compose up -d postgres
```

The default Compose application database is:

```text
postgresql://clinics:clinics@localhost:5432/clinics?schema=public
```

For isolated PostgreSQL integration tests, start the separate test database:

```powershell
docker compose up -d postgres-test
```

The test database is:

```text
postgresql://clinics_test:clinics_test@localhost:55432/clinics_test?schema=public
```

The test runner refuses to migrate or clean a database unless its database
name contains `test`.

## Install and initialize

Install exactly from the committed lockfile:

```powershell
npm ci
```

Generate Prisma Client and apply migrations:

```powershell
npm run prisma:generate
npm run prisma:migrate
```

The initial migration creates the tables, foreign keys, timestamp checks, and
the partial unique index described below.

## Development server

After `.env` is configured and migrations are applied:

```powershell
npm run dev
```

Or build and run:

```powershell
npm run build
npm start
```

The application is constructed in [app.ts](./src/app.ts), while
[server.ts](./src/server.ts) owns listening and signal handling. `SIGINT` and
`SIGTERM` close Fastify and disconnect Prisma.

Health check:

```powershell
curl.exe http://127.0.0.1:3000/health
```

Response:

```json
{ "status": "ok" }
```

## API endpoints

All identifiers are UUID strings. All timestamps are ISO 8601 values with an
explicit timezone. Responses use camelCase and UTC timestamps.

### Create a slot

```http
POST /clinics/:clinicId/slots
```

Request:

```json
{
  "startsAt": "2030-01-01T09:00:00Z",
  "endsAt": "2030-01-01T09:30:00Z"
}
```

Response: `201 Created`

```json
{
  "slot": {
    "id": "slot-uuid",
    "clinicId": "clinic-uuid",
    "startsAt": "2030-01-01T09:00:00.000Z",
    "endsAt": "2030-01-01T09:30:00.000Z",
    "status": "available",
    "availability": "available",
    "createdAt": "2026-10-23T08:00:00.000Z",
    "updatedAt": "2026-10-23T08:00:00.000Z",
    "cancelledAt": null
  }
}
```

Creation rejects timezone-naive timestamps, invalid ranges, and slots that
start in the past. The clinic must already exist.

### List clinic slots

```http
GET /clinics/:clinicId/slots
```

Query parameters:

- `from`: inclusive ISO timestamp filter on `startsAt`
- `to`: exclusive ISO timestamp filter on `startsAt`
- `status`: `available` or `cancelled`
- `availability`: `available` or `booked`
- `page`: positive page number, default `1`
- `limit`: integer from `1` to `100`, default `20`

Results are ordered by `startsAt ASC, id ASC`. Availability is derived from
confirmed bookings. Cancelled bookings do not reserve a slot.

Response: `200 OK`

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

### Retrieve a slot

```http
GET /slots/:slotId
```

Response: `200 OK` with the slot representation, including `availability`
(`available`, `booked`, or `cancelled`) but not booking or patient details.

### Cancel a slot

```http
DELETE /slots/:slotId
```

Response: `200 OK` with the cancelled slot. Cancellation is idempotent.
A slot with a confirmed booking returns `409 SLOT_HAS_CONFIRMED_BOOKING`.

### Book a slot

```http
POST /slots/:slotId/bookings
```

Request:

```json
{
  "patientId": "patient-uuid"
}
```

Response: `201 Created`

```json
{
  "booking": {
    "id": "booking-uuid",
    "slotId": "slot-uuid",
    "patientId": "patient-uuid",
    "status": "confirmed",
    "createdAt": "2026-10-23T08:00:00.000Z",
    "cancelledAt": null
  }
}
```

### Retrieve a booking

```http
GET /bookings/:bookingId
```

Response: `200 OK` with the booking representation. Cancelled bookings remain
retrievable for history.

### Cancel a booking

```http
DELETE /bookings/:bookingId
```

Response: `200 OK` with a booking whose status is `cancelled`. The booking
remains stored and can no longer occupy the active-booking index.

## Error responses

Every expected error uses this shape:

```json
{
  "error": {
    "code": "SLOT_ALREADY_BOOKED",
    "message": "This appointment slot is no longer available."
  }
}
```

| Status | Codes                                                                 |
| -----: | --------------------------------------------------------------------- |
|  `400` | `INVALID_REQUEST`, `INVALID_TIME_RANGE`, `SLOT_STARTS_IN_PAST`        |
|  `404` | `CLINIC_NOT_FOUND`, `SLOT_NOT_FOUND`, `BOOKING_NOT_FOUND`             |
|  `409` | `SLOT_ALREADY_BOOKED`, `SLOT_CANCELLED`, `SLOT_HAS_CONFIRMED_BOOKING` |
|  `500` | `INTERNAL_ERROR`                                                      |

Database errors, SQL, stack traces, and secrets are not returned to clients.

## Concurrency and database correctness

Booking runs in one Prisma transaction:

1. Lock the target slot row with parameterized `SELECT ... FOR UPDATE`.
2. Validate existence, cancellation state, and start time.
3. Check for a confirmed booking for a clearer conflict response.
4. Insert the confirmed booking.
5. Commit.

The availability query is not the guarantee. PostgreSQL enforces the final
invariant with this manually authored migration index:

```sql
CREATE UNIQUE INDEX one_active_booking_per_slot
ON bookings (slot_id)
WHERE status = 'confirmed';
```

Only the known active-booking unique violation maps to
`409 SLOT_ALREADY_BOOKED`. Other database errors remain internal failures.

Slot cancellation and booking cancellation acquire the slot lock before
checking or changing mutable state. If booking commits first, slot cancellation
returns `409 SLOT_HAS_CONFIRMED_BOOKING`. If slot cancellation commits first,
booking returns `409 SLOT_CANCELLED`.

## Database constraints

The initial migration in
[migration.sql](./prisma/migrations/20261023130000_init/migration.sql) enforces:

- UUID primary keys.
- Clinic-to-slot and slot-to-booking foreign keys.
- `ends_at > starts_at`.
- Valid slot and booking enum states.
- Consistent cancellation timestamps.
- One confirmed booking per slot through the partial unique index.
- Indexes for clinic/time/status listing and booking lookup.

The partial index is intentionally in SQL because Prisma schema syntax does not
represent this conditional uniqueness constraint directly. Future migrations
must preserve an equivalent index.

## Cancellation, rebooking, and assumptions

- A slot belongs to one clinic and has capacity one.
- Past slots cannot be booked.
- Overlapping slots are allowed because no doctor/resource constraint was
  requested.
- Repeated slot and booking cancellation is idempotent.
- Cancelled bookings remain history and release the slot for rebooking.
- Clinics exist through seed data or an external system; clinic/patient
  creation endpoints are not included.

Out of scope:

- Authentication and authorization.
- Proving ownership of a supplied clinic or patient identifier.
- Doctor/resource calendars and overlap prevention.
- Recurring slots, waitlists, rescheduling, notifications, payments, and
  administrative audit logs.

The API validates `patientId` as a UUID, but a client-supplied patient ID is
not authenticated identity. The system must not be described as production
secure until an authentication and authorization boundary is added.

Known limitations:

- No clinic/patient seed endpoint; tests create fixture clinics directly in
  PostgreSQL.
- Pagination is page/limit rather than cursor-based.
- Authentication and authorization are not implemented.

## Verification commands

Install from the lockfile:

```powershell
npm ci
```

Validate and generate Prisma:

```powershell
npm run prisma:validate
npm run prisma:generate
```

Static checks:

```powershell
npm run typecheck
npm run lint
npm run format:check
```

Run the default suite:

```powershell
npm test
```

Run the real PostgreSQL suite:

```powershell
docker compose up -d postgres-test
npm run test:postgres
```

The PostgreSQL suite uses real HTTP requests and real PostgreSQL transactions,
row locks, foreign keys, rollback, and the partial unique index. It asserts
persisted state after concurrent booking and cancellation races.
