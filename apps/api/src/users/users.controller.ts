import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  LOCALES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  ROLES,
  type UserSummary,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { UsersService } from './users.service.js';

const password = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
const roles = z.array(z.enum(ROLES)).min(1).max(ROLES.length);
const branchIds = z.array(z.uuid()).max(50);

const createBody = z.object({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  password,
  preferredLocale: z.enum(LOCALES),
  roles,
  branchIds,
});

const updateBody = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    preferredLocale: z.enum(LOCALES).optional(),
    roles: roles.optional(),
    branchIds: branchIds.optional(),
  })
  .strict();

const resetBody = z.object({ password });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.path.join('.') || i.message));
  }
  return result.data;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users:view')
  list(): Promise<UserSummary[]> {
    return this.users.list();
  }

  @Post()
  @RequirePermission('users:create')
  create(@Body() body: unknown): Promise<UserSummary> {
    return this.users.create(parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('users:update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<UserSummary> {
    return this.users.update(id, parse(updateBody, body));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserSummary> {
    return this.users.setActive(actor.id, id, false);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  activate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserSummary> {
    return this.users.setActive(actor.id, id, true);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('users:update')
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    return this.users.resetPassword(id, parse(resetBody, body).password);
  }
}
