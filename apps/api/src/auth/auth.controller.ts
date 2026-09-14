import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { loginInputSchema, type SessionUserDto } from '@reviews/contracts';
import { AuthService, type LoginResult } from './auth.service.js';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * The one endpoint that must be reachable without a token — everything
   * else is private by default under the global JwtAuthGuard.
   *
   * The request body is parsed through the shared `loginInputSchema` from
   * `@reviews/contracts` rather than a parallel class-validator DTO, so the
   * API and any future client validate against exactly the same shape.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown): Promise<LoginResult> {
    const parsed = loginInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    return this.authService.login(parsed.data.email, parsed.data.password);
  }

  /** Returns the session user for the token on the request. */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<SessionUserDto> {
    return this.authService.getSessionUser(user.id);
  }
}
