import type { FastifyInstance } from 'fastify';
import {
  createSlotBodySchema,
  clinicParamsSchema,
  listSlotsQuerySchema,
  slotParamsSchema,
} from './slot.schemas.js';
import { PrismaSlotRepository, type SlotRepository } from './slot.repository.js';
import { SlotService } from './slot.service.js';

function serializeSlot(slot: {
  id: string;
  clinicId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  availability?: string;
}) {
  return {
    id: slot.id,
    clinicId: slot.clinicId,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
    status: slot.status,
    ...(slot.availability ? { availability: slot.availability } : {}),
    createdAt: slot.createdAt.toISOString(),
    updatedAt: slot.updatedAt.toISOString(),
    cancelledAt: slot.cancelledAt?.toISOString() ?? null,
  };
}

export function registerSlotRoutes(app: FastifyInstance, repository?: SlotRepository): void {
  const service = new SlotService(repository ?? new PrismaSlotRepository(app.prisma));

  app.post('/clinics/:clinicId/slots', async (request, reply) => {
    const params = clinicParamsSchema.parse(request.params);
    const body = createSlotBodySchema.parse(request.body);
    const slot = await service.createSlot(params.clinicId, body);
    return reply.status(201).send({ slot: serializeSlot(slot) });
  });

  app.get('/clinics/:clinicId/slots', async (request) => {
    const params = clinicParamsSchema.parse(request.params);
    const query = listSlotsQuerySchema.parse(request.query);
    const result = await service.listSlots(params.clinicId, query);
    return {
      items: result.items.map(serializeSlot),
      pagination: {
        page: query.page,
        limit: query.limit,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / query.limit),
      },
    };
  });

  app.get('/slots/:slotId', async (request) => {
    const params = slotParamsSchema.parse(request.params);
    const slot = await service.getSlot(params.slotId);
    return { slot: serializeSlot(slot) };
  });

  app.delete('/slots/:slotId', async (request) => {
    const params = slotParamsSchema.parse(request.params);
    const slot = await service.cancelSlot(params.slotId);
    return { slot: serializeSlot(slot) };
  });
}
