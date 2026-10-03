import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MAX_DOCUMENT_BYTES, type ShipmentDocumentDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { Document } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { cleanFileName, detectContentType } from './file-type.js';

export interface UploadInput {
  typeCode: string;
  fileName: string;
  note: string | null;
  data: Buffer;
}

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
    await this.masterData.requireDocumentType(input.typeCode);
    if (input.data.length === 0) throw new BadRequestException('The file is empty');
    if (input.data.length > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException('Files are limited to 10 MB');
    }
    const contentType = detectContentType(input.data);
    if (!contentType)
      throw new BadRequestException('Only PDF, JPEG, PNG and WebP files are accepted');
    const document = await this.prisma.document.create({
      data: {
        branchId: shipment.branchId,
        shipmentId,
        typeCode: input.typeCode,
        fileName: cleanFileName(input.fileName),
        contentType,
        sizeBytes: input.data.length,
        sha256: createHash('sha256').update(input.data).digest('hex'),
        note: input.note,
        uploadedById: user.id,
        content: { create: { data: new Uint8Array(input.data) } },
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
