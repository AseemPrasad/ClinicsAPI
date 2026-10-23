import type { Booking } from '@prisma/client';
import { AppError } from '../../shared/errors.js';
import { BookingRepositoryError, type BookingRepository } from './booking.repository.js';
import type { CreateBookingInput } from './booking.schemas.js';

function mapRepositoryError(error: BookingRepositoryError): AppError {
  switch (error.code) {
    case 'SLOT_NOT_FOUND':
      return new AppError(404, 'SLOT_NOT_FOUND', 'The appointment slot was not found.');
    case 'SLOT_CANCELLED':
      return new AppError(409, 'SLOT_CANCELLED', 'The appointment slot has been cancelled.');
    case 'SLOT_IN_PAST':
      return new AppError(409, 'SLOT_STARTS_IN_PAST', 'A past appointment slot cannot be booked.');
    case 'SLOT_ALREADY_BOOKED':
      return new AppError(
        409,
        'SLOT_ALREADY_BOOKED',
        'This appointment slot is no longer available.',
      );
    case 'BOOKING_NOT_FOUND':
      return new AppError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
  }
}

export class BookingService {
  public constructor(private readonly repository: BookingRepository) {}

  public async createBooking(slotId: string, input: CreateBookingInput): Promise<Booking> {
    try {
      return await this.repository.createBooking({ slotId, patientId: input.patientId });
    } catch (error) {
      if (error instanceof BookingRepositoryError) {
        throw mapRepositoryError(error);
      }
      throw error;
    }
  }

  public async getBooking(bookingId: string): Promise<Booking> {
    const booking = await this.repository.findBooking(bookingId);
    if (!booking) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
    }
    return booking;
  }

  public async cancelBooking(bookingId: string): Promise<Booking> {
    try {
      return await this.repository.cancelBooking(bookingId);
    } catch (error) {
      if (error instanceof BookingRepositoryError) {
        throw mapRepositoryError(error);
      }
      throw error;
    }
  }
}
