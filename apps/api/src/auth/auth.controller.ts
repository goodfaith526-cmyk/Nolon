import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthMeResponse } from '@nolon/shared';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from './auth-user.js';
import { AuthService } from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';
import { SESSION_COOKIE, readCookie } from './session-token.js';

const loginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.NO_CONTENT)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Email and password are required');

    const result = await this.auth.login(parsed.data.email, parsed.data.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new UnauthorizedException('Invalid email or password');
    }
    res.cookie(SESSION_COOKIE, result.token, { ...COOKIE_OPTIONS, expires: result.expiresAt });
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthMeResponse> {
    return this.auth.describe(user);
  }
}
