import type { AppointmentSlot, AppointmentSlotStatus, Prisma, PrismaClient } from '@prisma/client';

export type SlotWithAvailability = AppointmentSlot & {
  availability: 'available' | 'booked' | 'cancelled';
};

export interface SlotRepository {
  clinicExists(clinicId: string): Promise<boolean>;
  createSlot(input: { clinicId: string; startsAt: Date; endsAt: Date }): Promise<AppointmentSlot>;
  listSlots(input: {
    clinicId: string;
    from?: Date;
    to?: Date;
    status?: AppointmentSlotStatus;
    availability?: 'available' | 'booked';
    skip: number;
    take: number;
  }): Promise<{ items: SlotWithAvailability[]; totalItems: number }>;
  findSlot(slotId: string): Promise<SlotWithAvailability | null>;
  cancelSlot(slotId: string): Promise<AppointmentSlot>;
}

function slotAvailability(slot: AppointmentSlot, confirmedBooking: boolean): SlotWithAvailability {
  return {
    ...slot,
    availability:
      slot.status === 'cancelled' ? 'cancelled' : confirmedBooking ? 'booked' : 'available',
  };
}

export class PrismaSlotRepository implements SlotRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async clinicExists(clinicId: string): Promise<boolean> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true },
    });
    return clinic !== null;
  }

  public createSlot(input: {
    clinicId: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<AppointmentSlot> {
    return this.prisma.appointmentSlot.create({ data: input });
  }

  public async listSlots(input: {
    clinicId: string;
    from?: Date;
    to?: Date;
    status?: AppointmentSlotStatus;
    availability?: 'available' | 'booked';
    skip: number;
    take: number;
  }): Promise<{ items: SlotWithAvailability[]; totalItems: number }> {
    const where: Prisma.AppointmentSlotWhereInput = {
      clinicId: input.clinicId,
      ...(input.from || input.to
        ? {
            startsAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lt: input.to } : {}),
            },
          }
        : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.availability === 'booked'
        ? { bookings: { some: { status: 'confirmed' } } }
        : input.availability === 'available'
          ? { status: 'available', bookings: { none: { status: 'confirmed' } } }
          : {}),
    };

    const [slots, totalItems] = await this.prisma.$transaction([
      this.prisma.appointmentSlot.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: input.skip,
        take: input.take,
        include: { bookings: { where: { status: 'confirmed' }, select: { id: true } } },
      }),
      this.prisma.appointmentSlot.count({ where }),
    ]);

    return {
      items: slots.map(({ bookings, ...slot }) => slotAvailability(slot, bookings.length > 0)),
      totalItems,
    };
  }

  public async findSlot(slotId: string): Promise<SlotWithAvailability | null> {
    const slot = await this.prisma.appointmentSlot.findUnique({
      where: { id: slotId },
      include: { bookings: { where: { status: 'confirmed' }, select: { id: true } } },
    });
    if (!slot) return null;
    const { bookings, ...slotData } = slot;
    return slotAvailability(slotData, bookings.length > 0);
  }

  public async cancelSlot(slotId: string): Promise<AppointmentSlot> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<unknown[]>`
        SELECT id FROM appointment_slots WHERE id = ${slotId}::uuid FOR UPDATE
      `;

      const slot = await transaction.appointmentSlot.findUnique({
        where: { id: slotId },
      });
      if (!slot) {
        throw new Error('SLOT_NOT_FOUND');
      }
      if (slot.status === 'cancelled') {
        return slot;
      }

      const confirmedBooking = await transaction.booking.findFirst({
        where: { slotId, status: 'confirmed' },
        select: { id: true },
      });
      if (confirmedBooking) {
        throw new Error('SLOT_HAS_CONFIRMED_BOOKING');
      }

      return transaction.appointmentSlot.update({
        where: { id: slotId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    });
  }
}
