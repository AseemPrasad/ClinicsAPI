import { z } from 'zod';

export const bookingParamsSchema = z.object({
  slotId: z.string().uuid(),
});

export const bookingIdParamsSchema = z.object({
  bookingId: z.string().uuid(),
});

export const createBookingBodySchema = z.object({
  patientId: z.string().uuid(),
});

export type CreateBookingInput = z.infer<typeof createBookingBodySchema>;
