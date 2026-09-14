import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from '../auth/decorators/public.decorator.js';
import { REDIS_CLIENT } from '../common/redis/redis.constants.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

type DependencyStatus = 'up' | 'down';

interface ReadinessBody {
  status: 'ok' | 'error';
  checks: {
    database: DependencyStatus;
    cache: DependencyStatus;
  };
}

// A hung dependency must not hang the health check itself: readiness is
// meant to answer quickly so an orchestrator's probe interval is meaningful.
const DEPENDENCY_CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// Both endpoints here are public: an orchestrator's liveness/readiness
// probes carry no bearer token, and the failing-closed global JwtAuthGuard
// would otherwise 401 them.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Liveness: reports the process is up and running its event loop.
   * Deliberately touches no dependency — a Redis or Postgres blip must not
   * make an orchestrator restart an otherwise healthy process.
   */
  @Get()
  liveness(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * Readiness: checks every dependency the API needs to serve a request.
   * Returns 503 (via a thrown HttpException, handled by the global
   * exception filter) when any dependency is down.
   */
  @Get('ready')
  async readiness(): Promise<ReadinessBody> {
    const [database, cache] = await Promise.all([this.checkDatabase(), this.checkCache()]);
    const body: ReadinessBody = {
      status: database === 'up' && cache === 'up' ? 'ok' : 'error',
      checks: { database, cache },
    };

    if (body.status === 'error') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DEPENDENCY_CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkCache(): Promise<DependencyStatus> {
    try {
      const pong = await withTimeout(this.redis.ping(), DEPENDENCY_CHECK_TIMEOUT_MS);
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
