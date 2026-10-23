import type { FastifyInstance } from 'fastify';
import { BookingService } from './booking.service.js';
import {
  bookingIdParamsSchema,
  bookingParamsSchema,
  createBookingBodySchema,
} from './booking.schemas.js';
import { PrismaBookingRepository, type BookingRepository } from './booking.repository.js';

function serializeBooking(booking: {
  id: string;
  slotId: string;
  patientId: string;
  status: string;
  createdAt: Date;
  cancelledAt: Date | null;
}) {
  return {
    id: booking.id,
    slotId: booking.slotId,
    patientId: booking.patientId,
    status: booking.status,
    createdAt: booking.createdAt.toISOString(),
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
  };
}

export function registerBookingRoutes(app: FastifyInstance, repository?: BookingRepository): void {
  const service = new BookingService(repository ?? new PrismaBookingRepository(app.prisma));

  app.post('/slots/:slotId/bookings', async (request, reply) => {
    const params = bookingParamsSchema.parse(request.params);
    const body = createBookingBodySchema.parse(request.body);
    const booking = await service.createBooking(params.slotId, body);
    return reply.status(201).send({ booking: serializeBooking(booking) });
  });

  app.get('/bookings/:bookingId', async (request) => {
    const params = bookingIdParamsSchema.parse(request.params);
    const booking = await service.getBooking(params.bookingId);
    return { booking: serializeBooking(booking) };
  });

  app.delete('/bookings/:bookingId', async (request) => {
    const params = bookingIdParamsSchema.parse(request.params);
    const booking = await service.cancelBooking(params.bookingId);
    return { booking: serializeBooking(booking) };
  });
}
