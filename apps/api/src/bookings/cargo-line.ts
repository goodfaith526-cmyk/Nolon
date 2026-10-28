import type { BookingItemInput } from '@nolon/shared';
import { dec } from '../common/money.js';
import { onFields } from '../common/rule-issues.js';
import { fieldRefusal } from '../common/validation.js';
import type { MasterDataService } from '../master-data/master-data.service.js';
import { cbmFromDimensions } from './cbm.js';

/** Largest value `booking_items.volume_cbm` (Decimal(12, 4)) holds. */
const MAX_VOLUME_CBM = dec('99999999.9999');

/**
 * One cargo line of a booking or of a shipment's correction (B3-3), checked and measured as the
 * booking checks it: a container line names an active container type and no other line does,
 * dimensions come together and give the volume (else the volume given), and a refusal names its
 * fields under `path` (`items.<index>`).
 */
export async function prepareCargoLine(
  masterData: MasterDataService,
  item: BookingItemInput,
  path: string,
) {
  const containerType = [`${path}.containerTypeCode`];
  if (item.cargoType === 'CONTAINER') {
    if (!item.containerTypeCode) {
      throw fieldRefusal(
        'CONTAINER_TYPE_REQUIRED',
        'A container line needs a container type',
        containerType,
      );
    }
    const code = item.containerTypeCode;
    await onFields(
      containerType,
      () => masterData.requireContainerType(code),
      'UNKNOWN_CONTAINER_TYPE',
    );
  } else if (item.containerTypeCode) {
    throw fieldRefusal(
      'CONTAINER_TYPE_NOT_APPLICABLE',
      'Container type applies to container lines only',
      containerType,
    );
  }
  const length = item.lengthCm ? dec(item.lengthCm) : null;
  const width = item.widthCm ? dec(item.widthCm) : null;
  const height = item.heightCm ? dec(item.heightCm) : null;
  const dimensions = [length, width, height].filter((d) => d !== null).length;
  if (dimensions !== 0 && dimensions !== 3) {
    // The missing ones are named: those are the fields to fill in.
    const missing = (['lengthCm', 'widthCm', 'heightCm'] as const).filter((k) => !item[k]);
    throw fieldRefusal(
      'DIMENSIONS_TOGETHER',
      'Give length, width and height together',
      missing.map((k) => `${path}.${k}`),
    );
  }
  const volumeCbm =
    length && width && height
      ? cbmFromDimensions(length, width, height, item.quantity)
      : item.volumeCbm
        ? dec(item.volumeCbm)
        : null;
  if (volumeCbm?.gt(MAX_VOLUME_CBM)) {
    const fields = length
      ? ['lengthCm', 'widthCm', 'heightCm', 'quantity']
      : ['volumeCbm', 'quantity'];
    throw fieldRefusal(
      'VOLUME_TOO_LARGE',
      'Volume is too large; check the dimensions and quantity',
      fields.map((k) => `${path}.${k}`),
    );
  }
  const category = item.priceCategoryCode ?? null;
  if (category) {
    await onFields(
      [`${path}.priceCategoryCode`],
      () => masterData.requirePriceCategory(category, item.cargoType),
      'PRICE_CATEGORY_NOT_USABLE',
    );
  }
  return {
    cargoType: item.cargoType,
    containerTypeCode: item.containerTypeCode ?? null,
    description: item.description ?? null,
    quantity: item.quantity,
    lengthCm: length,
    widthCm: width,
    heightCm: height,
    weightKg: item.weightKg ? dec(item.weightKg) : null,
    volumeCbm,
    priceCategoryCode: category,
  };
}
