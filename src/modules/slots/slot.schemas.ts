import { z } from 'zod';

const uuid = z.string().uuid();

const timestamp = z
  .string()
  .refine((value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value), {
    message: 'Timestamp must include an explicit timezone.',
  })
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Timestamp must be a valid ISO 8601 value.',
  });

export const clinicParamsSchema = z.object({ clinicId: uuid });
export const slotParamsSchema = z.object({ slotId: uuid });

export const createSlotBodySchema = z.object({
  startsAt: timestamp,
  endsAt: timestamp,
});

export const listSlotsQuerySchema = z.object({
  from: timestamp.optional(),
  to: timestamp.optional(),
  status: z.enum(['available', 'cancelled']).optional(),
  availability: z.enum(['available', 'booked']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateSlotInput = z.infer<typeof createSlotBodySchema>;
export type ListSlotsQuery = z.infer<typeof listSlotsQuerySchema>;
