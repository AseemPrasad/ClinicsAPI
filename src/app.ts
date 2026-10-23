import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { registerErrorHandler } from './shared/error-handler.js';
import { registerSlotRoutes } from './modules/slots/slot.routes.js';
import type { SlotRepository } from './modules/slots/slot.repository.js';
import { registerBookingRoutes } from './modules/bookings/booking.routes.js';
import type { BookingRepository } from './modules/bookings/booking.repository.js';

export interface AppOptions {
  prisma?: PrismaClient;
  slotRepository?: SlotRepository;
  bookingRepository?: BookingRepository;
  logger?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const prisma = options.prisma ?? new PrismaClient();

  app.decorate('prisma', prisma);

  app.get('/health', async () => ({ status: 'ok' }));
  registerSlotRoutes(app, options.slotRepository);
  registerBookingRoutes(app, options.bookingRepository);

  registerErrorHandler(app);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
