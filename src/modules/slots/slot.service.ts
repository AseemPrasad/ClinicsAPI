import type { AppointmentSlot } from '@prisma/client';
import { AppError } from '../../shared/errors.js';
import type { CreateSlotInput, ListSlotsQuery } from './slot.schemas.js';
import type { SlotRepository, SlotWithAvailability } from './slot.repository.js';

export class SlotService {
  public constructor(private readonly repository: SlotRepository) {}

  public async createSlot(clinicId: string, input: CreateSlotInput): Promise<AppointmentSlot> {
    if (!(await this.repository.clinicExists(clinicId))) {
      throw new AppError(404, 'CLINIC_NOT_FOUND', 'The clinic was not found.');
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= startsAt) {
      throw new AppError(
        400,
        'INVALID_TIME_RANGE',
        'The slot end time must be after its start time.',
      );
    }
    if (startsAt <= new Date()) {
      throw new AppError(400, 'SLOT_STARTS_IN_PAST', 'A slot must start in the future.');
    }

    return this.repository.createSlot({ clinicId, startsAt, endsAt });
  }

  public listSlots(
    clinicId: string,
    query: ListSlotsQuery,
  ): Promise<{ items: SlotWithAvailability[]; totalItems: number }> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && to <= from) {
      throw new AppError(
        400,
        'INVALID_TIME_RANGE',
        'The end filter must be after the start filter.',
      );
    }

    const repositoryInput = {
      clinicId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.availability ? { availability: query.availability } : {}),
    };

    return this.repository.listSlots(repositoryInput);
  }

  public async getSlot(slotId: string): Promise<SlotWithAvailability> {
    const slot = await this.repository.findSlot(slotId);
    if (!slot) {
      throw new AppError(404, 'SLOT_NOT_FOUND', 'The appointment slot was not found.');
    }
    return slot;
  }

  public async cancelSlot(slotId: string): Promise<AppointmentSlot> {
    try {
      return await this.repository.cancelSlot(slotId);
    } catch (error) {
      if (error instanceof Error && error.message === 'SLOT_NOT_FOUND') {
        throw new AppError(404, 'SLOT_NOT_FOUND', 'The appointment slot was not found.');
      }
      if (error instanceof Error && error.message === 'SLOT_HAS_CONFIRMED_BOOKING') {
        throw new AppError(
          409,
          'SLOT_HAS_CONFIRMED_BOOKING',
          'A slot with a confirmed booking cannot be cancelled.',
        );
      }
      throw error;
    }
  }
}
