import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { SessionUserDto } from '@reviews/contracts';
import type { User } from '@reviews/db';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { hashPassword, verifyPassword } from './password.js';

export interface LoginResult {
  accessToken: string;
  user: SessionUserDto;
}

// A fixed, never-matching password whose hash we verify against when the
// requested email does not exist. This is what makes login's timing
// independent of whether the account exists: both branches — user found
// with a wrong password, and user not found at all — perform one argon2
// verification before failing, so an attacker timing responses cannot use
// latency to enumerate registered emails. Hashed once and memoized (module
// scope, computed on first use) rather than hashed on every request: the
// value never changes, and repeating the hash would only cost CPU.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('timing-safety-dummy-password-never-assigned-to-a-user');
  return dummyHashPromise;
}

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Verifies credentials and, on success, signs a session token.
   *
   * The verification step always runs — against the real user's hash when
   * one exists, against the fixed dummy hash otherwise — before either
   * failure path is taken, and both failure paths throw the exact same
   * exception (same status, same message), so the response discloses
   * nothing about whether `email` belongs to a real account.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const hashToVerify = user ? user.passwordHash : await getDummyHash();
    const passwordMatches = await verifyPassword(hashToVerify, password);

    if (!user || !passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const accessToken = this.jwtService.sign({ sub: user.id, email: user.email, role: user.role });
    return { accessToken, user: toSessionUser(user) };
  }

  /** Loads the current session user by id, for GET /auth/me. */
  async getSessionUser(id: string): Promise<SessionUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }
    return toSessionUser(user);
  }
}

// Builds the response DTO field by field rather than spreading the Prisma
// row, so `passwordHash` cannot leak into a response no matter what other
// columns are added to the users table later.
function toSessionUser(user: User): SessionUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}
