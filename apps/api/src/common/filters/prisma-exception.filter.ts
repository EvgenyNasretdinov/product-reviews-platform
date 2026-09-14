import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@reviews/db';
import type { Response } from 'express';

/**
 * Global exception filter.
 *
 * Prisma's `PrismaClientKnownRequestError` carries a stable `code` for known
 * failure modes; two of those map directly onto HTTP semantics that later
 * tasks depend on:
 *   - P2002 (unique constraint violation) -> 409 Conflict. Review
 *     submission relies on this to reject a duplicate via the database's
 *     unique constraint rather than a racy check-then-insert.
 *   - P2025 (record not found, e.g. an update/delete with no match) -> 404.
 *
 * Every other exception falls back to standard Nest HttpException handling,
 * or a generic 500 for anything unrecognised.
 */
@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        response.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: 'Resource already exists',
        });
        return;
      }
      if (exception.code === 'P2025') {
        response.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
        });
        return;
      }
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
