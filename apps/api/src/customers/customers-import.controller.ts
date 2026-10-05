import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ImportPreviewDto, ImportResultDto } from '@nolon/shared';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import {
  IMPORT_UPLOAD_LIMITS,
  commitBody,
  templateDownload,
  templateLocale,
  templateQuery,
} from '../imports/import-http.js';
import type { UploadedWorkbook } from '../imports/import-sheet.js';
import { CustomersImportService } from './customers-import.service.js';

/**
 * Excel import of customers (scope 18): the template, a preview that writes nothing, and the
 * all-or-nothing commit. Importing creates customers, so it needs customers:create; rows may
 * name only the user's branches.
 */
@Controller('customers/import')
export class CustomersImportController {
  constructor(private readonly imports: CustomersImportService) {}

  @Get('template')
  @RequirePermission('customers:create')
  async template(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { locale } = parse(templateQuery, query);
    return templateDownload(res, await this.imports.template(user, templateLocale(user, locale)));
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:create')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_LIMITS))
  preview(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedWorkbook | undefined,
  ): Promise<ImportPreviewDto> {
    return this.imports.preview(user, file);
  }

  @Post()
  @RequirePermission('customers:create')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_LIMITS))
  commit(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedWorkbook | undefined,
    @Body() body: unknown,
  ): Promise<ImportResultDto> {
    return this.imports.commit(user, file, parse(commitBody, body).requestId);
  }
}
