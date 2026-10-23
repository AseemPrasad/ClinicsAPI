import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    if (error.validation) {
      reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request is invalid.',
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request is invalid.',
        },
      });
      return;
    }

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }

    request.log.error({ err: error }, 'Unhandled application error');
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });
}
