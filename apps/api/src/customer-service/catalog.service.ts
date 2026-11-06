import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CS_CATALOG_SERVICES,
  type CsCatalogDto,
  type CsRequestService,
  type CsCatalogPlaceDto,
  type LocationDto,
  pricingModeOf,
} from '@nolon/shared';
import { todayIn } from '../common/dates.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RatesService } from '../rates/rates.service.js';
import { dropOffDto, dropOffSelect } from './drop-off.js';

/**
 * The Customer Service catalog (R1, docs/plans/04 section 4): the places a bot can quote and book
 * between, the shipment types (price categories) and the services. Public master data only: no
 * price, cost or staff name. A place is listed when an APPROVED rate card valid today (UTC) covers
 * it: one on the place itself, on its city, or on its country (the pricing scopes of plan 5.3).
 * An origin is listed too when a routing rule covers it the same way (a branch serves it).
 * Countries themselves are not listed: a quote and a booking go between places. The services are
 * the ones the asking key offers (a soft launch may offer neither pickup nor door delivery).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly masterData: MasterDataService,
    private readonly rates: RatesService,
    private readonly prisma: PrismaService,
  ) {}

  async catalog(
    offered: readonly CsRequestService[],
    branchIds: readonly string[],
  ): Promise<CsCatalogDto> {
    const [all, aliases, ends, routing, phones, points] = await Promise.all([
      this.masterData.all(),
      this.masterData.locationAliases(),
      this.rates.approvedRouteEnds(todayIn('UTC')),
      this.masterData.routingBranches(),
      this.masterData.supportPhones(),
      // The key's branches only, as for the support numbers.
      this.prisma.warehouse.findMany({
        where: { isActive: true, acceptsDropOff: true, branchId: { in: [...branchIds] } },
        select: {
          ...dropOffSelect,
          branchId: true,
          locationId: true,
          branch: { select: { code: true } },
        },
        orderBy: { code: 'asc' },
      }),
    ]);
    // Places only: a country is a pricing scope, never a quote's or a booking's end.
    const active = all.locations.filter((l) => l.isActive && l.kind !== 'COUNTRY');
    const covered = (ids: readonly string[]) => {
      const set = new Set(ids);
      const countries = new Set(
        all.locations
          .filter((l) => l.kind === 'COUNTRY' && set.has(l.id))
          .map((l) => l.countryCode),
      );
      return active
        .filter(
          (l) =>
            set.has(l.id) ||
            (l.cityId !== null && set.has(l.cityId)) ||
            countries.has(l.countryCode),
        )
        .map((l) => place(l, aliases[l.id] ?? []));
    };
    const body: Omit<CsCatalogDto, 'version'> = {
      // A place a branch serves (section 6) is an origin too, priced or not.
      origins: covered([...ends.origins, ...Object.keys(routing)]),
      destinations: covered(ends.destinations),
      // The unit says what the bot must collect: pieces, or pieces and dimensions for a volume unit.
      categories: all.priceCategories
        .filter((c) => c.isActive)
        .map((c) => ({
          code: c.code,
          nameAr: c.nameAr,
          nameEn: c.nameEn,
          unit: c.defaultUnit,
          pricingMode: pricingModeOf(c.defaultUnit),
        })),
      services: CS_CATALOG_SERVICES.filter((s) => offered.includes(s.code)).map((s) => ({ ...s })),
      // Plan 09 amendment 4: the branches' customer service numbers. Trial 2026-11-06: every
      // branch that has one, not only the key's: after departure the customer calls the
      // destination branch (a public number, no branch data).
      support: phones.flatMap((p) =>
        p.phone !== null
          ? [
              {
                branchId: p.branchId,
                code: p.code,
                nameAr: p.nameAr,
                nameEn: p.nameEn,
                phone: p.phone,
              },
            ]
          : [],
      ),
      dropOffPoints: points.flatMap((w) => {
        const details = dropOffDto(w);
        return details
          ? [{ branchId: w.branchId, branchCode: w.branch.code, placeId: w.locationId, ...details }]
          : [];
      }),
    };
    const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return { version, ...body };
  }
}

function place(l: LocationDto, aliases: string[]): CsCatalogPlaceDto {
  return {
    id: l.id,
    code: l.code,
    kind: l.kind,
    nameAr: l.nameAr,
    nameEn: l.nameEn,
    countryCode: l.countryCode,
    aliases,
  };
}
