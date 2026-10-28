import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  PERMISSIONS,
  type AccessCatalogDto,
  type AccessTeamDto,
  type AuditLogEntryDto,
  type BranchAccessDto,
  type DelegatedPersonDto,
  type DelegationChangeDto,
  type DelegationDto,
  type MyDelegationDto,
  type PersonAccessDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { AccessControlService } from './access-control.service.js';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.path.join('.') || i.message));
  }
  return result.data;
}

const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const name = z.string().trim().min(1).max(100);
/** The access_state.version of the read the change was made from (F118-3). */
const expectedVersion = z.string().regex(/^\d{1,19}$/);

const createTeamBody = z
  .object({
    expectedVersion,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
    nameAr: name,
    nameEn: name,
    copyFromTeamId: z.uuid().optional(),
  })
  .strict();
const updateTeamBody = z
  .object({
    expectedVersion,
    nameAr: name.optional(),
    nameEn: name.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
const permissionsBody = z.object({ expectedVersion, permissions }).strict();
const previewBody = z.object({ permissions: permissions.nullable() }).strict();
const personBranchBody = z
  .object({
    expectedVersion,
    teamIds: z.array(z.uuid()).max(50),
    allow: permissions,
    deny: permissions,
  })
  .strict();
const delegationBody = z
  .object({ expectedVersion, branchId: z.uuid(), delegateUserId: z.uuid(), permissions })
  .strict();
const delegatedBody = z
  .object({ expectedVersion, teamIds: z.array(z.uuid()).max(50), allow: permissions })
  .strict();
const revokeBody = z.object({ expectedVersion }).strict();

/** The owner's permissions screen (plan 03, section 6): the Administrator only. */
@Controller('access-control')
export class AccessControlController {
  constructor(private readonly access: AccessControlService) {}

  @Get('catalog')
  @RequirePermission('access_control:view')
  catalog(): Promise<AccessCatalogDto> {
    return this.access.catalog();
  }

  @Post('teams')
  @RequirePermission('access_control:update')
  createTeam(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<AccessTeamDto> {
    return this.access.createTeam(actor, parse(createTeamBody, body));
  }

  @Patch('teams/:id')
  @RequirePermission('access_control:update')
  updateTeam(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AccessTeamDto> {
    return this.access.updateTeam(actor, id, parse(updateTeamBody, body));
  }

  @Put('teams/:id/permissions')
  @RequirePermission('access_control:update')
  setTeamPermissions(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AccessTeamDto> {
    const input = parse(permissionsBody, body);
    return this.access.setTeamPermissions(actor, id, input.permissions, input.expectedVersion);
  }

  @Get('branches/:id')
  @RequirePermission('access_control:view')
  branch(@Param('id', ParseUUIDPipe) id: string): Promise<BranchAccessDto> {
    return this.access.branch(id);
  }

  @Put('branches/:id/blocked')
  @RequirePermission('access_control:update')
  setBranchBlocked(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<BranchAccessDto> {
    const input = parse(permissionsBody, body);
    return this.access.setBranchBlocked(actor, id, input.permissions, input.expectedVersion);
  }

  @Get('people/:userId')
  @RequirePermission('access_control:view')
  person(@Param('userId', ParseUUIDPipe) userId: string): Promise<PersonAccessDto> {
    return this.access.person(userId);
  }

  @Put('people/:userId/branches/:branchId')
  @RequirePermission('access_control:update')
  setPersonBranch(
    @CurrentUser() actor: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() body: unknown,
  ): Promise<PersonAccessDto> {
    return this.access.setPersonBranch(actor, userId, branchId, parse(personBranchBody, body));
  }

  @Post('delegations')
  @RequirePermission('access_control:update')
  createDelegation(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<DelegationDto> {
    return this.access.createDelegation(actor, parse(delegationBody, body));
  }

  /** Read only: what a smaller ceiling or a revocation (`permissions: null`) would drop. */
  @Post('delegations/:id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('access_control:update')
  previewDelegation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DelegationChangeDto> {
    return this.access.previewDelegation(id, parse(previewBody, body).permissions);
  }

  @Put('delegations/:id/permissions')
  @RequirePermission('access_control:update')
  setDelegationPermissions(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DelegationChangeDto> {
    const input = parse(permissionsBody, body);
    return this.access.setDelegationPermissions(
      actor,
      id,
      input.permissions,
      input.expectedVersion,
    );
  }

  @Post('delegations/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('access_control:update')
  revokeDelegation(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<DelegationChangeDto> {
    return this.access.revokeDelegation(actor, id, parse(revokeBody, body).expectedVersion);
  }

  @Get('log')
  @RequirePermission('access_control:view')
  log(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<AuditLogEntryDto[]> {
    return this.access.log(Math.min(Math.max(limit, 1), 500));
  }
}

/**
 * The delegate's screen (plan 03, section 6): no permission of its own; the service answers only
 * the delegations the signed-in person holds, and rechecks them under the lock on every change.
 */
@Controller('branch-access')
export class BranchAccessController {
  constructor(private readonly access: AccessControlService) {}

  @Get()
  mine(@CurrentUser() user: AuthUser): Promise<MyDelegationDto[]> {
    return this.access.mine(user);
  }

  @Put(':delegationId/people/:userId')
  setDelegated(
    @CurrentUser() actor: AuthUser,
    @Param('delegationId', ParseUUIDPipe) delegationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ): Promise<DelegatedPersonDto> {
    return this.access.setDelegated(actor, delegationId, userId, parse(delegatedBody, body));
  }
}
