import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CS_CATALOG_SERVICES,
  type CsCatalogDto,
  type CsRequestService,
  type CsCatalogPlaceDto,
  type LocationDto,
} from '@nolon/shared';
import { todayIn } from '../common/dates.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { RatesService } from '../rates/rates.service.js';

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
  ) {}

  async catalog(offered: readonly CsRequestService[]): Promise<CsCatalogDto> {
    const [all, aliases, ends, routing] = await Promise.all([
      this.masterData.all(),
      this.masterData.locationAliases(),
      this.rates.approvedRouteEnds(todayIn('UTC')),
      this.masterData.routingBranches(),
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
      categories: all.priceCategories
        .filter((c) => c.isActive)
        .map((c) => ({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, unit: c.defaultUnit })),
      services: CS_CATALOG_SERVICES.filter((s) => offered.includes(s.code)).map((s) => ({ ...s })),
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
