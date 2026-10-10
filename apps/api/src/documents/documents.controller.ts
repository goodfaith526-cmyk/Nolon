import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_DOCUMENT_BYTES,
  type PackingListContentDto,
  type SheetPreviewDto,
  type ShipmentDocumentDto,
} from '@nolon/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { optionalText, parse } from '../common/validation.js';
import { DocumentsService } from './documents.service.js';
import { attachmentDisposition } from './file-type.js';

/** The part of a multer file this controller uses (kept in memory, never written to disk). */
interface UploadedPart {
  originalname: string;
  buffer: Buffer;
}

const uploadBody = z
  .object({
    typeCode: z.string().trim().toUpperCase().min(1).max(30),
    // Sent as a text field so non-ASCII (Arabic) names arrive intact; the part's own name is a
    // fallback.
    fileName: z.string().trim().max(255).optional(),
    note: optionalText(1000),
  })
  .strict();

@Controller('shipments/:shipmentId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('documents:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentDocumentDto[]> {
    return this.documents.list(user, shipmentId);
  }

  @Post()
  @RequirePermission('documents:create')
  @UseInterceptors(
    FileInterceptor('file', {
      // One more byte than allowed, so an oversized file is rejected rather than truncated.
      limits: { fileSize: MAX_DOCUMENT_BYTES + 1, files: 1, fields: 5, parts: 6 },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @UploadedFile() file: UploadedPart | undefined,
    @Body() body: unknown,
  ): Promise<ShipmentDocumentDto> {
    if (!file) throw new BadRequestException('Attach a file');
    const fields = parse(uploadBody, body);
    return this.documents.upload(user, shipmentId, {
      typeCode: fields.typeCode,
      fileName: fields.fileName || file.originalname,
      note: fields.note,
      data: file.buffer,
    });
  }

  /** The staff assistant reads a packing list as JSON (no file name, no download headers). */
  @AgentReadable()
  @Get(':documentId/packing-list-content')
  @RequirePermission('documents:view')
  packingListContent(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<PackingListContentDto> {
    return this.documents.packingListContent(user, shipmentId, documentId);
  }

  @Get(':documentId/file')
  @RequirePermission('documents:view')
  async file(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.documents.file(user, shipmentId, documentId);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': attachmentDisposition(file.fileName),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.data);
  }

  /**
   * A PDF or image shown inline next to a GRN draft. Its type is the one detected at upload (PDF
   * or image, never HTML or SVG), sniffing is off, and only NOLON itself may
   * frame it. (No CSP sandbox: browsers refuse to show a PDF in one.)
   */
  @Get(':documentId/preview')
  @RequirePermission('documents:view')
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.documents.preview(user, shipmentId, documentId);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.data);
  }

  /** The first sheet of an .xlsx document as text cells (formulas are not evaluated). */
  @Get(':documentId/sheet')
  @RequirePermission('documents:view')
  sheet(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<SheetPreviewDto> {
    return this.documents.sheet(user, shipmentId, documentId);
  }

  @Delete(':documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('documents:cancel')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<void> {
    return this.documents.remove(user, shipmentId, documentId);
  }
}
