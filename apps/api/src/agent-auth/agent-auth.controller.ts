import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type {
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentClientDto,
  AgentTokenResponse,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { AgentAuthService } from './agent-auth.service.js';
import { CHALLENGE_PATTERN, CLIENT_ID_PATTERN } from './agent-secrets.js';

const clientId = z.string().regex(CLIENT_ID_PATTERN);
const secret = z.string().min(1).max(200);
const uri = z.string().min(1).max(500);

const authorizeBody = z
  .object({
    clientId,
    redirectUri: uri,
    state: z.string().min(8).max(200),
    codeChallenge: z.string().regex(CHALLENGE_PATTERN),
    codeChallengeMethod: z.literal('S256'),
  })
  .strict();

const tokenBody = z
  .object({
    clientId,
    clientSecret: secret,
    code: z.string().min(1).max(200),
    codeVerifier: z.string().min(1).max(200),
    redirectUri: uri,
  })
  .strict();

const revokeBody = z.object({ clientId, clientSecret: secret, token: secret }).strict();

const createClientBody = z
  .object({
    name: requiredText(100),
    redirectUri: uri,
    audience: requiredText(100),
    tenant: requiredText(100),
  })
  .strict();

/** Delegated sign-in of the staff AI assistant. */
@Controller('agent-auth')
export class AgentAuthController {
  constructor(private readonly agentAuth: AgentAuthService) {}

  /** The signed-in staff member (session cookie, origin-checked) asks for a one-time code. */
  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<AgentAuthorizeResponse> {
    return this.agentAuth.authorize(user, parse(authorizeBody, body));
  }

  /** Server to server: the platform exchanges the code (with its secret and PKCE verifier). */
  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@Body() body: unknown): Promise<AgentTokenResponse> {
    return this.agentAuth.exchange(parse(tokenBody, body));
  }

  /** Server to server: the platform ends a token (its user signed out there). */
  @Public()
  @Post('revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Body() body: unknown): Promise<void> {
    return this.agentAuth.revoke(parse(revokeBody, body));
  }
}

/** The Administrator's registered assistant platforms. */
@Controller('agent-clients')
export class AgentClientsController {
  constructor(private readonly agentAuth: AgentAuthService) {}

  @Get()
  @RequirePermission('users:view')
  list(): Promise<AgentClientDto[]> {
    return this.agentAuth.listClients();
  }

  @Post()
  @RequirePermission('users:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<AgentClientCreatedDto> {
    return this.agentAuth.createClient(user, parse(createClientBody, body));
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentClientDto> {
    return this.agentAuth.revokeClient(user, id);
  }
}
