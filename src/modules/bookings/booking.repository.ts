import { Prisma, type Booking, type PrismaClient } from '@prisma/client';

export type BookingRepositoryErrorCode =
  | 'SLOT_NOT_FOUND'
  | 'SLOT_CANCELLED'
  | 'SLOT_IN_PAST'
  | 'SLOT_ALREADY_BOOKED'
  | 'BOOKING_NOT_FOUND';

export class BookingRepositoryError extends Error {
  public constructor(public readonly code: BookingRepositoryErrorCode) {
    super(code);
    this.name = 'BookingRepositoryError';
  }
}

function isActiveBookingUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.['target'];
  return Array.isArray(target) && target.length === 1 && target[0] === 'slot_id';
}

export interface BookingRepository {
  createBooking(input: { slotId: string; patientId: string }): Promise<Booking>;
  findBooking(bookingId: string): Promise<Booking | null>;
  cancelBooking(bookingId: string): Promise<Booking>;
}

export class PrismaBookingRepository implements BookingRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createBooking(input: { slotId: string; patientId: string }): Promise<Booking> {
    return this.prisma.$transaction(async (transaction) => {
      const lockedSlots = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM appointment_slots
        WHERE id = ${input.slotId}::uuid
        FOR UPDATE
      `;
      if (lockedSlots.length === 0) {
        throw new BookingRepositoryError('SLOT_NOT_FOUND');
      }

      const slot = await transaction.appointmentSlot.findUnique({
        where: { id: input.slotId },
        select: { status: true, startsAt: true },
      });
      if (!slot) {
        throw new BookingRepositoryError('SLOT_NOT_FOUND');
      }
      if (slot.status === 'cancelled') {
        throw new BookingRepositoryError('SLOT_CANCELLED');
      }
      if (slot.startsAt <= new Date()) {
        throw new BookingRepositoryError('SLOT_IN_PAST');
      }

      const confirmedBooking = await transaction.booking.findFirst({
        where: { slotId: input.slotId, status: 'confirmed' },
        select: { id: true },
      });
      if (confirmedBooking) {
        throw new BookingRepositoryError('SLOT_ALREADY_BOOKED');
      }

      try {
        return await transaction.booking.create({
          data: {
            slotId: input.slotId,
            patientId: input.patientId,
            status: 'confirmed',
          },
        });
      } catch (error) {
        if (isActiveBookingUniqueViolation(error)) {
          throw new BookingRepositoryError('SLOT_ALREADY_BOOKED');
        }
        throw error;
      }
    });
  }

  public findBooking(bookingId: string): Promise<Booking | null> {
    return this.prisma.booking.findUnique({ where: { id: bookingId } });
  }

  public async cancelBooking(bookingId: string): Promise<Booking> {
    return this.prisma.$transaction(async (transaction) => {
      const booking = await transaction.booking.findUnique({
        where: { id: bookingId },
        select: { slotId: true },
      });
      if (!booking) {
        throw new BookingRepositoryError('BOOKING_NOT_FOUND');
      }

      await transaction.$queryRaw<unknown[]>`
        SELECT id
        FROM appointment_slots
        WHERE id = ${booking.slotId}::uuid
        FOR UPDATE
      `;

      const lockedBooking = await transaction.booking.findUnique({
        where: { id: bookingId },
      });
      if (!lockedBooking) {
        throw new BookingRepositoryError('BOOKING_NOT_FOUND');
      }
      if (lockedBooking.status === 'cancelled') {
        return lockedBooking;
      }

      return transaction.booking.update({
        where: { id: bookingId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    });
  }
}
