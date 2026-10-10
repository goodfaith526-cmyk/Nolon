import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  MAX_DOCUMENT_BYTES,
  PACKING_LIST_DOCUMENT_TYPE,
  XLSX_CONTENT_TYPE,
  type PackingListContentDto,
  type SheetPreviewDto,
  type ShipmentDocumentDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { Document, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { cleanFileName, detectContentType, isXlsxWorkbook } from './file-type.js';
import { sheetPreview } from './sheet-preview.js';

export interface UploadInput {
  typeCode: string;
  fileName: string;
  note: string | null;
  data: Buffer;
}

/** An upload whose type, size and content were checked; ready to insert. */
export interface PreparedUpload extends UploadInput {
  contentType: string;
}

type Tx = Prisma.TransactionClient;

export interface DocumentFile {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Shipment documents (BL, invoices, packing lists, customs papers, POD, photos). Access follows
 * the shipment: a user who cannot see the shipment cannot see its documents.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly masterData: MasterDataService,
  ) {}

  async list(user: AuthUser, shipmentId: string): Promise<ShipmentDocumentDto[]> {
    await this.shipments.requireAccessible(user, shipmentId);
    const documents = await this.prisma.document.findMany({
      where: { shipmentId, deletedAt: null },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { uploadedAt: 'desc' },
    });
    return documents.map(toDto);
  }

  async upload(
    user: AuthUser,
    shipmentId: string,
    input: UploadInput,
  ): Promise<ShipmentDocumentDto> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (shipment.status === 'CANCELLED') {
      throw new ConflictException('A cancelled shipment does not take new documents');
    }
    const file = await this.prepare(input);
    return this.prisma.$transaction(async (tx) => {
      // Re-checked under the shipment lock: a cancel that commits meanwhile is seen here.
      if ((await this.shipments.lockForChildWrite(tx, shipmentId)) === 'CANCELLED') {
        throw new ConflictException('A cancelled shipment does not take new documents');
      }
      return this.insert(tx, user, shipment.branchId, shipmentId, file);
    });
  }

  /**
   * Checks an upload (type, size, content) before any transaction. For other modules attaching
   * files under a shipment (warehouse photos), with `insert`.
   */
  async prepare(input: UploadInput): Promise<PreparedUpload> {
    await this.masterData.requireDocumentType(input.typeCode);
    if (input.data.length === 0) throw new BadRequestException('The file is empty');
    if (input.data.length > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException('Files are limited to 10 MB');
    }
    const contentType =
      detectContentType(input.data) ??
      // Packing lists often come as spreadsheets: a checked .xlsx is accepted for that type only.
      (input.typeCode === PACKING_LIST_DOCUMENT_TYPE && isXlsxWorkbook(input.data)
        ? XLSX_CONTENT_TYPE
        : null);
    if (!contentType) {
      throw new BadRequestException(
        input.typeCode === PACKING_LIST_DOCUMENT_TYPE
          ? 'Only PDF, JPEG, PNG, WebP and .xlsx files are accepted'
          : 'Only PDF, JPEG, PNG and WebP files are accepted',
      );
    }
    return { ...input, contentType };
  }

  /**
   * Inserts a prepared file inside the caller's transaction. The caller has checked access to the
   * shipment and holds its lock (ShipmentsService.lockForChildWrite).
   */
  async insert(
    tx: Tx,
    user: AuthUser,
    branchId: string,
    shipmentId: string,
    file: PreparedUpload,
  ): Promise<ShipmentDocumentDto> {
    const document = await tx.document.create({
      data: {
        branchId,
        shipmentId,
        typeCode: file.typeCode,
        fileName: cleanFileName(file.fileName),
        contentType: file.contentType,
        sizeBytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        note: file.note,
        uploadedById: user.id,
        content: { create: { data: new Uint8Array(file.data) } },
      },
      include: { uploadedBy: { select: { fullName: true } } },
    });
    return toDto(document);
  }

  async file(user: AuthUser, shipmentId: string, documentId: string): Promise<DocumentFile> {
    await this.shipments.requireAccessible(user, shipmentId);
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, shipmentId, deletedAt: null },
      include: { content: true },
    });
    if (!document?.content) throw new NotFoundException('Document not found');
    return {
      fileName: document.fileName,
      contentType: document.contentType,
      data: Buffer.from(document.content.data),
    };
  }

  /**
   * A packing list's bytes for the staff assistant to read, as JSON: its detected type, size and
   * sha256, never its file name. 404 for any other document type, a deleted document, or a
   * shipment the user cannot see.
   */
  async packingListContent(
    user: AuthUser,
    shipmentId: string,
    documentId: string,
  ): Promise<PackingListContentDto> {
    await this.shipments.requireAccessible(user, shipmentId);
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        shipmentId,
        typeCode: PACKING_LIST_DOCUMENT_TYPE,
        deletedAt: null,
      },
      include: { content: true },
    });
    if (!document?.content) throw new NotFoundException('Packing list not found');
    return {
      documentId: document.id,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      dataBase64: Buffer.from(document.content.data).toString('base64'),
    };
  }

  /**
   * A packing list of the shipment, for a GRN draft: not deleted, with these bytes (sha256).
   * 404 otherwise. The caller has checked access to the shipment.
   */
  async requirePackingList(
    tx: Tx,
    shipmentId: string,
    documentId: string,
    sha256: string,
  ): Promise<{ id: string }> {
    const document = await tx.document.findFirst({
      where: {
        id: documentId,
        shipmentId,
        typeCode: PACKING_LIST_DOCUMENT_TYPE,
        deletedAt: null,
        sha256,
      },
      select: { id: true },
    });
    if (!document) throw new NotFoundException('Packing list not found');
    return document;
  }

  /**
   * A PDF or image document to show inline on a review screen (the controller serves it
   * sandboxed). 404 for other types: spreadsheets are shown through `sheet`.
   */
  async preview(user: AuthUser, shipmentId: string, documentId: string): Promise<DocumentFile> {
    const file = await this.file(user, shipmentId, documentId);
    if (file.contentType !== 'application/pdf' && !file.contentType.startsWith('image/')) {
      throw new NotFoundException('No preview for this document');
    }
    return file;
  }

  /** The first sheet of an .xlsx document as text cells; 404 for other types. */
  async sheet(user: AuthUser, shipmentId: string, documentId: string): Promise<SheetPreviewDto> {
    const file = await this.file(user, shipmentId, documentId);
    if (file.contentType !== XLSX_CONTENT_TYPE) {
      throw new NotFoundException('This document is not a spreadsheet');
    }
    const preview = await sheetPreview(file.data);
    if (!preview) throw new NotFoundException('The spreadsheet cannot be read');
    return preview;
  }

  /** Soft delete: the file disappears from the shipment; who uploaded and deleted it remains. */
  async remove(user: AuthUser, shipmentId: string, documentId: string): Promise<void> {
    await this.shipments.requireAccessible(user, shipmentId);
    const { count } = await this.prisma.document.updateMany({
      where: { id: documentId, shipmentId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: user.id },
    });
    if (count === 0) throw new NotFoundException('Document not found');
  }
}

function toDto(d: Document & { uploadedBy: { fullName: string } }): ShipmentDocumentDto {
  return {
    id: d.id,
    typeCode: d.typeCode,
    fileName: d.fileName,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    note: d.note,
    uploadedByName: d.uploadedBy.fullName,
    uploadedAt: d.uploadedAt.toISOString(),
  };
}
