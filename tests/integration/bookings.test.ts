import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppointmentSlot, Booking } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import {
  BookingRepositoryError,
  type BookingRepository,
} from '../../src/modules/bookings/booking.repository.js';
import type {
  SlotRepository,
  SlotWithAvailability,
} from '../../src/modules/slots/slot.repository.js';

const clinicId = randomUUID();
const patientId = randomUUID();

function makeSlot(overrides: Partial<AppointmentSlot> = {}): AppointmentSlot {
  const now = new Date();
  return {
    id: randomUUID(),
    clinicId,
    startsAt: new Date(now.getTime() + 86_400_000),
    endsAt: new Date(now.getTime() + 90_000_000),
    status: 'available',
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
    ...overrides,
  };
}

class ConcurrentState {
  public readonly slots = new Map<string, AppointmentSlot>();
  public readonly bookings = new Map<string, Booking>();
  private lockTail: Promise<void> = Promise.resolve();

  public async withSlotLock<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class FakeBookingRepository implements BookingRepository {
  public constructor(private readonly state: ConcurrentState) {}

  public async createBooking(input: { slotId: string; patientId: string }): Promise<Booking> {
    return this.state.withSlotLock(input.slotId, async () => {
      const slot = this.state.slots.get(input.slotId);
      if (!slot) throw new BookingRepositoryError('SLOT_NOT_FOUND');
      if (slot.status === 'cancelled') throw new BookingRepositoryError('SLOT_CANCELLED');
      if (slot.startsAt <= new Date()) throw new BookingRepositoryError('SLOT_IN_PAST');
      if (
        [...this.state.bookings.values()].some(
          (booking) => booking.slotId === input.slotId && booking.status === 'confirmed',
        )
      ) {
        throw new BookingRepositoryError('SLOT_ALREADY_BOOKED');
      }

      const now = new Date();
      const booking: Booking = {
        id: randomUUID(),
        slotId: input.slotId,
        patientId: input.patientId,
        status: 'confirmed',
        createdAt: now,
        cancelledAt: null,
      };
      this.state.bookings.set(booking.id, booking);
      return booking;
    });
  }

  public async findBooking(bookingId: string): Promise<Booking | null> {
    return this.state.bookings.get(bookingId) ?? null;
  }

  public async cancelBooking(bookingId: string): Promise<Booking> {
    const existing = this.state.bookings.get(bookingId);
    if (!existing) throw new BookingRepositoryError('BOOKING_NOT_FOUND');
    return this.state.withSlotLock(existing.slotId, async () => {
      const booking = this.state.bookings.get(bookingId);
      if (!booking) throw new BookingRepositoryError('BOOKING_NOT_FOUND');
      if (booking.status === 'cancelled') return booking;
      booking.status = 'cancelled';
      booking.cancelledAt = new Date();
      return booking;
    });
  }
}

class FakeSlotRepository implements SlotRepository {
  public constructor(private readonly state: ConcurrentState) {}

  public async clinicExists(): Promise<boolean> {
    return true;
  }

  public async createSlot(input: {
    clinicId: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<AppointmentSlot> {
    const slot = makeSlot(input);
    this.state.slots.set(slot.id, slot);
    return slot;
  }

  public async listSlots(): Promise<{ items: SlotWithAvailability[]; totalItems: number }> {
    return { items: [], totalItems: 0 };
  }

  public async findSlot(slotId: string): Promise<SlotWithAvailability | null> {
    const slot = this.state.slots.get(slotId);
    return slot ? { ...slot, availability: 'available' } : null;
  }

  public async cancelSlot(slotId: string): Promise<AppointmentSlot> {
    return this.state.withSlotLock(slotId, async () => {
      const slot = this.state.slots.get(slotId);
      if (!slot) throw new Error('SLOT_NOT_FOUND');
      if (
        [...this.state.bookings.values()].some(
          (booking) => booking.slotId === slotId && booking.status === 'confirmed',
        )
      ) {
        throw new Error('SLOT_HAS_CONFIRMED_BOOKING');
      }
      if (slot.status === 'available') {
        slot.status = 'cancelled';
        slot.cancelledAt = new Date();
      }
      return slot;
    });
  }
}

describe('booking endpoints', () => {
  let app: ReturnType<typeof buildApp>;
  let state: ConcurrentState;

  beforeEach(() => {
    state = new ConcurrentState();
    app = buildApp({
      logger: false,
      slotRepository: new FakeSlotRepository(state),
      bookingRepository: new FakeBookingRepository(state),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function addSlot(overrides: Partial<AppointmentSlot> = {}): Promise<AppointmentSlot> {
    const slot = makeSlot(overrides);
    state.slots.set(slot.id, slot);
    return slot;
  }

  async function book(slotId: string, customPatientId = patientId) {
    return app.inject({
      method: 'POST',
      url: `/slots/${slotId}/bookings`,
      payload: { patientId: customPatientId },
    });
  }

  it('books an available future slot', async () => {
    const slot = await addSlot();
    const response = await book(slot.id);
    expect(response.statusCode).toBe(201);
    expect(response.json().booking.status).toBe('confirmed');
  });

  it('rejects invalid identifiers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/slots/not-a-uuid/bookings',
      payload: { patientId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an already-booked slot', async () => {
    const slot = await addSlot();
    expect((await book(slot.id)).statusCode).toBe(201);
    const response = await book(slot.id, randomUUID());
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SLOT_ALREADY_BOOKED');
  });

  it('rejects a cancelled, past, or nonexistent slot', async () => {
    const cancelled = await addSlot({ status: 'cancelled', cancelledAt: new Date() });
    const past = await addSlot({
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
    });
    expect((await book(cancelled.id)).json().error.code).toBe('SLOT_CANCELLED');
    expect((await book(past.id)).json().error.code).toBe('SLOT_STARTS_IN_PAST');
    expect((await book(randomUUID())).json().error.code).toBe('SLOT_NOT_FOUND');
  });

  it('cancels a booking and preserves its history', async () => {
    const slot = await addSlot();
    const created = await book(slot.id);
    const bookingId = created.json().booking.id as string;
    const response = await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.status).toBe('cancelled');
    expect(state.bookings.get(bookingId)?.cancelledAt).toBeInstanceOf(Date);
  });

  it('returns not found for a missing booking and is idempotent when repeated', async () => {
    const missing = await app.inject({
      method: 'DELETE',
      url: `/bookings/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('BOOKING_NOT_FOUND');

    const slot = await addSlot();
    const created = await book(slot.id);
    const bookingId = created.json().booking.id as string;
    const first = await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });
    const second = await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().booking.status).toBe('cancelled');
  });

  it('retrieves a booking after cancellation and allows rebooking', async () => {
    const slot = await addSlot();
    const created = await book(slot.id);
    const bookingId = created.json().booking.id as string;
    await app.inject({ method: 'DELETE', url: `/bookings/${bookingId}` });

    const retrieved = await app.inject({ method: 'GET', url: `/bookings/${bookingId}` });
    const rebooked = await book(slot.id, randomUUID());
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().booking.status).toBe('cancelled');
    expect(rebooked.statusCode).toBe(201);
  });

  it('allows only one concurrent booking to commit', async () => {
    const slot = await addSlot();
    const responses = await Promise.all([book(slot.id, randomUUID()), book(slot.id, randomUUID())]);
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
    expect(
      [...state.bookings.values()].filter((booking) => booking.status === 'confirmed'),
    ).toHaveLength(1);
  });

  it('serializes booking against slot cancellation', async () => {
    const slot = await addSlot();
    const [bookingResponse, cancellationResponse] = await Promise.all([
      book(slot.id),
      app.inject({ method: 'DELETE', url: `/slots/${slot.id}` }),
    ]);
    expect(
      (bookingResponse.statusCode === 201 && cancellationResponse.statusCode === 409) ||
        (bookingResponse.statusCode === 409 && cancellationResponse.statusCode === 200),
    ).toBe(true);
    if (bookingResponse.statusCode === 201) {
      expect(state.slots.get(slot.id)?.status).toBe('available');
      expect(state.bookings.size).toBe(1);
    } else {
      expect(state.slots.get(slot.id)?.status).toBe('cancelled');
      expect(state.bookings.size).toBe(0);
    }
  });
});
