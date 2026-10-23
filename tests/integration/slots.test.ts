import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppointmentSlot } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import type {
  SlotRepository,
  SlotWithAvailability,
} from '../../src/modules/slots/slot.repository.js';

const clinicId = randomUUID();
const otherClinicId = randomUUID();

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

class FakeSlotRepository implements SlotRepository {
  public slots: AppointmentSlot[] = [];
  public confirmedSlotIds = new Set<string>();

  public async clinicExists(id: string): Promise<boolean> {
    return id === clinicId || id === otherClinicId;
  }

  public async createSlot(input: {
    clinicId: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<AppointmentSlot> {
    const slot = makeSlot(input);
    this.slots.push(slot);
    return slot;
  }

  public async listSlots(input: {
    clinicId: string;
    from?: Date;
    to?: Date;
    status?: 'available' | 'cancelled';
    availability?: 'available' | 'booked';
    skip: number;
    take: number;
  }): Promise<{ items: SlotWithAvailability[]; totalItems: number }> {
    const filtered = this.slots
      .filter((slot) => slot.clinicId === input.clinicId)
      .filter((slot) => !input.from || slot.startsAt >= input.from)
      .filter((slot) => !input.to || slot.startsAt < input.to)
      .filter((slot) => !input.status || slot.status === input.status)
      .filter((slot) => {
        const availability =
          slot.status === 'cancelled'
            ? 'cancelled'
            : this.confirmedSlotIds.has(slot.id)
              ? 'booked'
              : 'available';
        return !input.availability || input.availability === availability;
      })
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
    return {
      items: filtered
        .slice(input.skip, input.skip + input.take)
        .map((slot) => this.withAvailability(slot)),
      totalItems: filtered.length,
    };
  }

  public async findSlot(id: string): Promise<SlotWithAvailability | null> {
    const slot = this.slots.find((candidate) => candidate.id === id);
    return slot ? this.withAvailability(slot) : null;
  }

  public async cancelSlot(id: string): Promise<AppointmentSlot> {
    const slot = this.slots.find((candidate) => candidate.id === id);
    if (!slot) throw new Error('SLOT_NOT_FOUND');
    if (this.confirmedSlotIds.has(id)) throw new Error('SLOT_HAS_CONFIRMED_BOOKING');
    if (slot.status === 'available') {
      slot.status = 'cancelled';
      slot.cancelledAt = new Date();
      slot.updatedAt = new Date();
    }
    return slot;
  }

  private withAvailability(slot: AppointmentSlot): SlotWithAvailability {
    return {
      ...slot,
      availability:
        slot.status === 'cancelled'
          ? 'cancelled'
          : this.confirmedSlotIds.has(slot.id)
            ? 'booked'
            : 'available',
    };
  }
}

describe('slot endpoints', () => {
  let app: ReturnType<typeof buildApp>;
  let repository: FakeSlotRepository;

  beforeEach(() => {
    repository = new FakeSlotRepository();
    app = buildApp({ logger: false, slotRepository: repository });
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a future slot', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/clinics/${clinicId}/slots`,
      payload: {
        startsAt: '2030-01-01T09:00:00+05:30',
        endsAt: '2030-01-01T09:30:00+05:30',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().slot.status).toBe('available');
  });

  it.each([
    ['missing timezone', '2030-01-01T09:00:00', '2030-01-01T09:30:00Z'],
    ['invalid timestamp', 'not-a-date', '2030-01-01T09:30:00Z'],
  ])('rejects %s', async (_name, startsAt, endsAt) => {
    const response = await app.inject({
      method: 'POST',
      url: `/clinics/${clinicId}/slots`,
      payload: { startsAt, endsAt },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an end time before or equal to the start time', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/clinics/${clinicId}/slots`,
      payload: {
        startsAt: '2030-01-01T09:30:00Z',
        endsAt: '2030-01-01T09:30:00Z',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_TIME_RANGE');
  });

  it('returns a missing clinic error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/clinics/${randomUUID()}/slots`,
      payload: {
        startsAt: '2030-01-01T09:00:00Z',
        endsAt: '2030-01-01T09:30:00Z',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CLINIC_NOT_FOUND');
  });

  it('lists, filters, and paginates slots by availability', async () => {
    const first = makeSlot({ startsAt: new Date('2030-01-01T09:00:00Z') });
    const second = makeSlot({ startsAt: new Date('2030-01-01T10:00:00Z') });
    repository.slots.push(first, second);
    repository.confirmedSlotIds.add(second.id);

    const response = await app.inject({
      method: 'GET',
      url: `/clinics/${clinicId}/slots?availability=available&page=1&limit=1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].id).toBe(first.id);
    expect(response.json().pagination.totalItems).toBe(1);
  });

  it('rejects invalid pagination', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/clinics/${clinicId}/slots?page=0&limit=101`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('retrieves a slot and returns availability without booking details', async () => {
    const slot = makeSlot();
    repository.slots.push(slot);
    const response = await app.inject({ method: 'GET', url: `/slots/${slot.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().slot.availability).toBe('available');
    expect(response.json().slot.bookings).toBeUndefined();
  });

  it('returns a missing slot error', async () => {
    const response = await app.inject({ method: 'GET', url: `/slots/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('SLOT_NOT_FOUND');
  });

  it('cancels an available slot and repeats cancellation idempotently', async () => {
    const slot = makeSlot();
    repository.slots.push(slot);
    const first = await app.inject({ method: 'DELETE', url: `/slots/${slot.id}` });
    const second = await app.inject({ method: 'DELETE', url: `/slots/${slot.id}` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().slot.status).toBe('cancelled');
  });

  it('rejects cancellation when a confirmed booking exists', async () => {
    const slot = makeSlot();
    repository.slots.push(slot);
    repository.confirmedSlotIds.add(slot.id);
    const response = await app.inject({ method: 'DELETE', url: `/slots/${slot.id}` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SLOT_HAS_CONFIRMED_BOOKING');
  });
});
