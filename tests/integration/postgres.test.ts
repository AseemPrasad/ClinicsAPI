import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type AppointmentSlot, type Clinic } from '@prisma/client';
import { buildApp } from '../../src/app.js';

const databaseUrl = process.env['DATABASE_URL'];
const databaseName = databaseUrl
  ? (new URL(databaseUrl).pathname.slice(1).split('?')[0] ?? '')
  : '';
const postgresTestDatabase = databaseName.length > 0 && /(^|[_-])test([_-]|$)/i.test(databaseName);

function futureTime(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function errorBody(response: { json(): unknown }): { error: { code: string; message: string } } {
  return response.json() as { error: { code: string; message: string } };
}

describe.skipIf(!postgresTestDatabase)('PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildApp>;
  let clinic: Clinic;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    app = buildApp({ logger: false, prisma });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clinic = await prisma.clinic.create({ data: { name: `QA clinic ${randomUUID()}` } });
  });

  afterEach(async () => {
    await prisma.booking.deleteMany({
      where: { slot: { clinicId: clinic.id } },
    });
    await prisma.appointmentSlot.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.clinic.delete({ where: { id: clinic.id } });
  });

  async function createSlot(
    overrides: Partial<Pick<AppointmentSlot, 'startsAt' | 'endsAt'>> = {},
  ): Promise<AppointmentSlot> {
    const startsAt = overrides.startsAt ?? futureTime(60);
    const endsAt = overrides.endsAt ?? new Date(startsAt.getTime() + 30 * 60_000);
    const slot = await prisma.appointmentSlot.create({
      data: { clinicId: clinic.id, startsAt, endsAt },
    });
    return slot;
  }

  async function book(slotId: string, patientId = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: `/slots/${slotId}/bookings`,
      payload: { patientId },
    });
  }

  it('creates a valid slot and returns the documented representation', async () => {
    const startsAt = futureTime(60);
    const response = await app.inject({
      method: 'POST',
      url: `/clinics/${clinic.id}/slots`,
      payload: {
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 1_800_000).toISOString(),
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().slot).toMatchObject({
      clinicId: clinic.id,
      status: 'available',
      availability: 'available',
    });
  });

  it('rejects invalid timestamps, identifiers, and non-increasing times', async () => {
    const invalidTimestamp = await app.inject({
      method: 'POST',
      url: `/clinics/${clinic.id}/slots`,
      payload: { startsAt: '2030-01-01T09:00:00', endsAt: '2030-01-01T09:30:00Z' },
    });
    const invalidIdentifier = await app.inject({
      method: 'GET',
      url: '/slots/not-a-uuid',
    });
    const invalidRange = await app.inject({
      method: 'POST',
      url: `/clinics/${clinic.id}/slots`,
      payload: { startsAt: '2030-01-01T09:30:00Z', endsAt: '2030-01-01T09:30:00Z' },
    });
    expect(errorBody(invalidTimestamp).error.code).toBe('INVALID_REQUEST');
    expect(invalidIdentifier.statusCode).toBe(400);
    expect(errorBody(invalidRange).error.code).toBe('INVALID_TIME_RANGE');
  });

  it('returns missing slot and supports filters, stable pagination, and cancellation', async () => {
    const first = await createSlot({ startsAt: futureTime(60) });
    const second = await createSlot({ startsAt: futureTime(120) });
    const missing = await app.inject({ method: 'GET', url: `/slots/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(errorBody(missing).error.code).toBe('SLOT_NOT_FOUND');

    const list = await app.inject({
      method: 'GET',
      url: `/clinics/${clinic.id}/slots?availability=available&page=1&limit=1`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].id).toBe(first.id);
    expect(list.json().pagination).toMatchObject({ page: 1, limit: 1, totalItems: 2 });

    const cancelled = await app.inject({ method: 'DELETE', url: `/slots/${second.id}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().slot.status).toBe('cancelled');
  });

  it('rejects cancellation when a confirmed booking exists', async () => {
    const slot = await createSlot();
    expect((await book(slot.id)).statusCode).toBe(201);
    const response = await app.inject({ method: 'DELETE', url: `/slots/${slot.id}` });
    expect(response.statusCode).toBe(409);
    expect(errorBody(response).error.code).toBe('SLOT_HAS_CONFIRMED_BOOKING');
    expect((await prisma.appointmentSlot.findUnique({ where: { id: slot.id } }))?.status).toBe(
      'available',
    );
  });

  it('books, retrieves, cancels, repeats cancellation, and rebooks with history intact', async () => {
    const slot = await createSlot();
    const created = await book(slot.id);
    expect(created.statusCode).toBe(201);
    const bookingId = created.json().booking.id as string;

    const retrieved = await app.inject({ method: 'GET', url: `/bookings/${bookingId}` });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().booking.status).toBe('confirmed');

    const cancelled = await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });
    const repeated = await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });
    expect(cancelled.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().booking.status).toBe('cancelled');

    const rebooked = await book(slot.id, randomUUID());
    expect(rebooked.statusCode).toBe(201);
    const history = await prisma.booking.findMany({ where: { slotId: slot.id } });
    expect(history).toHaveLength(2);
    expect(history.filter((booking) => booking.status === 'cancelled')).toHaveLength(1);
    expect(history.filter((booking) => booking.status === 'confirmed')).toHaveLength(1);
  });

  it('returns the expected booking conflicts and never exposes SQL or stack details', async () => {
    const slot = await createSlot();
    const first = await book(slot.id);
    const duplicate = await book(slot.id, randomUUID());
    const cancelled = await createSlot({ startsAt: futureTime(60) });
    await prisma.appointmentSlot.update({
      where: { id: cancelled.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const cancelledResponse = await book(cancelled.id);
    const past = await createSlot({
      startsAt: new Date(Date.now() - 120_000),
      endsAt: new Date(Date.now() + 60_000),
    });
    const pastResponse = await book(past.id);
    const missingBooking = await app.inject({
      method: 'DELETE',
      url: `/bookings/${randomUUID()}`,
    });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(errorBody(duplicate).error.code).toBe('SLOT_ALREADY_BOOKED');
    expect(cancelledResponse.statusCode).toBe(409);
    expect(errorBody(cancelledResponse).error.code).toBe('SLOT_CANCELLED');
    expect(pastResponse.statusCode).toBe(409);
    expect(errorBody(pastResponse).error.code).toBe('SLOT_STARTS_IN_PAST');
    expect(missingBooking.statusCode).toBe(404);
    expect(JSON.stringify(errorBody(duplicate))).not.toMatch(/sql|stack|prisma/i);
  });

  it('allows exactly one concurrent booking and leaves one confirmed row', async () => {
    const slot = await createSlot();
    const responses = await Promise.all([book(slot.id, randomUUID()), book(slot.id, randomUUID())]);
    const successful = responses.filter((response) => response.statusCode === 201);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    const bookings = await prisma.booking.findMany({ where: { slotId: slot.id } });
    const persistedConfirmed = bookings.filter((booking) => booking.status === 'confirmed');
    const persistedSlot = await prisma.appointmentSlot.findUnique({ where: { id: slot.id } });

    expect(successful).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(bookings).toHaveLength(1);
    expect(persistedConfirmed).toHaveLength(1);
    expect(persistedSlot?.status).toBe('available');
    expect(
      responses.every((response) => response.statusCode === 201 || response.statusCode === 409),
    ).toBe(true);
  });

  it('serializes two cancellation requests and preserves one cancelled booking', async () => {
    const slot = await createSlot();
    const created = await book(slot.id);
    const bookingId = created.json().booking.id as string;
    const responses = await Promise.all([
      app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` }),
      app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` }),
    ]);
    const persisted = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200]);
    expect(persisted?.status).toBe('cancelled');
    expect(persisted?.cancelledAt).toBeInstanceOf(Date);
  });

  it('serializes booking against slot cancellation and allows booking after committed cancellation', async () => {
    const slot = await createSlot();
    const race = await Promise.all([
      book(slot.id),
      app.inject({ method: 'DELETE', url: `/slots/${slot.id}` }),
    ]);
    expect(race.filter((response) => response.statusCode === 409)).toHaveLength(1);
    expect(
      race.some((response) => response.statusCode === 201) ||
        race.some((response) => response.statusCode === 200),
    ).toBe(true);
    const racedSlot = await prisma.appointmentSlot.findUnique({ where: { id: slot.id } });
    const racedBookings = await prisma.booking.count({
      where: { slotId: slot.id, status: 'confirmed' },
    });
    expect(racedSlot?.status === 'available' || racedSlot?.status === 'cancelled').toBe(true);
    expect(racedBookings).toBe(racedSlot?.status === 'available' ? 1 : 0);

    const nextSlot = await createSlot();
    const cancellation = await app.inject({ method: 'DELETE', url: `/slots/${nextSlot.id}` });
    const afterCommit = await book(nextSlot.id);
    expect(cancellation.statusCode).toBe(200);
    expect(afterCommit.statusCode).toBe(409);
    expect(errorBody(afterCommit).error.code).toBe('SLOT_CANCELLED');
  });

  it('rolls back a failed booking without leaving a partial row', async () => {
    const slot = await createSlot();
    await prisma.$executeRaw`
      ALTER TABLE bookings
      ADD CONSTRAINT qa_booking_patient_not_zero CHECK (patient_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    `;
    let response;
    try {
      response = await book(slot.id, '00000000-0000-0000-0000-000000000000');
    } finally {
      await prisma.$executeRaw`ALTER TABLE bookings DROP CONSTRAINT qa_booking_patient_not_zero`;
    }
    const bookings = await prisma.booking.count({ where: { slotId: slot.id } });
    expect(response.statusCode).toBe(500);
    expect(bookings).toBe(0);
  });
});
