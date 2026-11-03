import type { WarehouseKind } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { MasterDataService } from '../master-data/master-data.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { WarehousesService } from '../warehouse/warehouses.service.js';
import { type PlaceSpec, SOFT_LAUNCH_PLACES, findPlace } from './soft-launch.js';

/**
 * Trial facilities (owner's request, 2026-11-03): collection centres in the origin cities, a
 * central distribution hub in Suakin, delivery centres in the Sudanese cities NOLON delivers to,
 * and a window in every city of the network (drop-off in the origins, pick-up in Sudan; owner,
 * 2026-11-03), each with an address, a phone number and a map position.
 * EVERYTHING here is made up, for trying the system only: the addresses are approximate districts,
 * the phone numbers are not NOLON's and the positions are near the named district, not a real
 * building. Every name ends in «(تجريبي)» / «(trial)», every code starts with TR- and every address
 * says it is not real, so staff can tell them apart and turn them off when the real ones arrive.
 *
 * Choices made without the client (to be confirmed by NOLON): Riyadh (added when missing) belongs to JED; Cairo and Guangzhou centres belong to DXB, as
 * their bot requests are routed there; Suakin belongs to PTS and Dongola to ATB.
 *
 * Safe to run again: a facility whose code exists is left exactly as it is (even when staff
 * turned it off), and nothing is deleted. Places are only read, except Suakin and Riyadh, which are
 * added when missing; a place that is missing or turned off is reported and its facilities skipped (a place
 * staff turned off is never turned back on, Codex F160-1).
 */

/** Said in every trial facility's address. */
export const TRIAL_ADDRESS_PREFIX = 'عنوان وهمي للتجربة فقط: ';

/**
 * The only places this script may add when missing (the hub's town, and Riyadh for its windows);
 * never turned back on when off.
 */
export const SUAKIN: PlaceSpec = {
  code: 'SDSWA',
  kind: 'CITY',
  nameEn: 'Suakin',
  nameAr: 'سواكن',
  countryCode: 'SD',
  aliases: [],
};

export const RIYADH: PlaceSpec = {
  code: 'SARUH',
  kind: 'CITY',
  nameEn: 'Riyadh',
  nameAr: 'الرياض',
  countryCode: 'SA',
  aliases: [],
};

export const ADDABLE_PLACES: readonly PlaceSpec[] = [SUAKIN, RIYADH];

export interface FacilitySpec {
  /** TR-..., at most 20 characters. */
  code: string;
  kind: WarehouseKind;
  branchCode: string;
  /** Code of the place in the locations master. */
  place: string;
  nameAr: string;
  nameEn: string;
  /** Without the trial prefix. */
  address: string;
  /** E.164, made up. */
  phone: string;
  latitude: string;
  longitude: string;
}

export const TRIAL_FACILITIES: readonly FacilitySpec[] = [
  // Collection centres in the origin cities.
  {
    code: 'TR-JED-CC',
    kind: 'COLLECTION_CENTER',
    branchCode: 'JED',
    place: 'SAJED',
    nameAr: 'مركز تجميع جدة',
    nameEn: 'Jeddah collection centre',
    address: 'حي الخُمرة، المنطقة الصناعية جنوب ميناء جدة الإسلامي، جدة',
    phone: '+966500000101',
    latitude: '21.371500',
    longitude: '39.226800',
  },
  {
    code: 'TR-DXB-CC',
    kind: 'COLLECTION_CENTER',
    branchCode: 'DXB',
    place: 'AEDXB',
    nameAr: 'مركز تجميع دبي',
    nameEn: 'Dubai collection centre',
    address: 'منطقة رأس الخور الصناعية 2، دبي',
    phone: '+971500000201',
    latitude: '25.179500',
    longitude: '55.353000',
  },
  {
    code: 'TR-SHJ-CC',
    kind: 'COLLECTION_CENTER',
    branchCode: 'DXB',
    place: 'AESHJ',
    nameAr: 'مركز تجميع الشارقة',
    nameEn: 'Sharjah collection centre',
    address: 'المنطقة الصناعية 13، الشارقة',
    phone: '+971500000202',
    latitude: '25.310500',
    longitude: '55.412000',
  },
  {
    code: 'TR-CAI-CC',
    kind: 'COLLECTION_CENTER',
    branchCode: 'DXB',
    place: 'EGCAI',
    nameAr: 'مركز تجميع القاهرة',
    nameEn: 'Cairo collection centre',
    address: 'المنطقة الحرة العامة، مدينة نصر، القاهرة',
    phone: '+201000000301',
    latitude: '30.056000',
    longitude: '31.346000',
  },
  {
    code: 'TR-CAN-CC',
    kind: 'COLLECTION_CENTER',
    branchCode: 'DXB',
    place: 'CNCAN',
    nameAr: 'مركز تجميع قوانزو',
    nameEn: 'Guangzhou collection centre',
    address: 'منطقة بايون، قوانزو',
    phone: '+8613000000401',
    latitude: '23.178000',
    longitude: '113.265000',
  },
  // The central distribution hub.
  {
    code: 'TR-SWA-HUB',
    kind: 'DISTRIBUTION_HUB',
    branchCode: 'PTS',
    place: 'SDSWA',
    nameAr: 'مركز التوزيع المركزي سواكن',
    nameEn: 'Suakin central distribution hub',
    address: 'طريق الميناء، سواكن، ولاية البحر الأحمر',
    phone: '+249900000501',
    latitude: '19.106000',
    longitude: '37.333000',
  },
  // Delivery centres in the destination cities.
  {
    code: 'TR-PZU-DC',
    kind: 'DELIVERY_CENTER',
    branchCode: 'PTS',
    place: 'SDPZU',
    nameAr: 'مركز تسليم بورتسودان',
    nameEn: 'Port Sudan delivery centre',
    address: 'السوق الكبير، وسط بورتسودان',
    phone: '+249900000502',
    latitude: '19.615800',
    longitude: '37.216400',
  },
  {
    code: 'TR-ATB-DC',
    kind: 'DELIVERY_CENTER',
    branchCode: 'ATB',
    place: 'SDATB',
    nameAr: 'مركز تسليم عطبرة',
    nameEn: 'Atbara delivery centre',
    address: 'السوق الكبير، عطبرة',
    phone: '+249900000503',
    latitude: '17.702000',
    longitude: '33.986000',
  },
  {
    code: 'TR-KRT-DC',
    kind: 'DELIVERY_CENTER',
    branchCode: 'KRT',
    place: 'SDKRT',
    nameAr: 'مركز تسليم الخرطوم',
    nameEn: 'Khartoum delivery centre',
    address: 'المنطقة الصناعية، الخرطوم بحري',
    phone: '+249900000504',
    latitude: '15.642000',
    longitude: '32.537000',
  },
  {
    code: 'TR-DOG-DC',
    kind: 'DELIVERY_CENTER',
    branchCode: 'ATB',
    place: 'SDDOG',
    nameAr: 'مركز تسليم دنقلا',
    nameEn: 'Dongola delivery centre',
    address: 'السوق الكبير، دنقلا',
    phone: '+249900000505',
    latitude: '19.169000',
    longitude: '30.476000',
  },
  // Drop-off windows in the origin cities.
  {
    code: 'TR-JED-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'JED',
    place: 'SAJED',
    nameAr: 'نافذة استلام جدة - الصفا',
    nameEn: 'Jeddah drop-off window - Al Safa',
    address: 'حي الصفا، شارع الأمير متعب، جدة',
    phone: '+966500000102',
    latitude: '21.588000',
    longitude: '39.214000',
  },
  {
    code: 'TR-JED-W2',
    kind: 'DROP_OFF_POINT',
    branchCode: 'JED',
    place: 'SAJED',
    nameAr: 'نافذة استلام جدة - البلد',
    nameEn: 'Jeddah drop-off window - Al Balad',
    address: 'حي البلد، قرب سوق باب مكة، جدة',
    phone: '+966500000103',
    latitude: '21.485000',
    longitude: '39.186000',
  },
  {
    code: 'TR-DXB-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'DXB',
    place: 'AEDXB',
    nameAr: 'نافذة استلام دبي - ديرة',
    nameEn: 'Dubai drop-off window - Deira',
    address: 'ديرة، قرب سوق نايف، دبي',
    phone: '+971500000203',
    latitude: '25.271000',
    longitude: '55.308000',
  },
  {
    code: 'TR-DXB-W2',
    kind: 'DROP_OFF_POINT',
    branchCode: 'DXB',
    place: 'AEDXB',
    nameAr: 'نافذة استلام دبي - القصيص',
    nameEn: 'Dubai drop-off window - Al Qusais',
    address: 'القصيص الصناعية 2، دبي',
    phone: '+971500000204',
    latitude: '25.279000',
    longitude: '55.377000',
  },
  {
    code: 'TR-SHJ-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'DXB',
    place: 'AESHJ',
    nameAr: 'نافذة استلام الشارقة - النهدة',
    nameEn: 'Sharjah drop-off window - Al Nahda',
    address: 'النهدة، قرب حديقة النهدة، الشارقة',
    phone: '+971500000205',
    latitude: '25.300000',
    longitude: '55.375000',
  },
  {
    code: 'TR-CAI-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'DXB',
    place: 'EGCAI',
    nameAr: 'نافذة استلام القاهرة - عين شمس',
    nameEn: 'Cairo drop-off window - Ain Shams',
    address: 'شارع أحمد عصمت، عين شمس، القاهرة',
    phone: '+201000000302',
    latitude: '30.131000',
    longitude: '31.329000',
  },
  {
    code: 'TR-RUH-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'JED',
    place: 'SARUH',
    nameAr: 'نافذة استلام الرياض - البطحاء',
    nameEn: 'Riyadh drop-off window - Al Batha',
    address: 'حي البطحاء، قرب سوق البطحاء، الرياض',
    phone: '+966500000104',
    latitude: '24.631000',
    longitude: '46.716000',
  },
  {
    code: 'TR-RUH-W2',
    kind: 'DROP_OFF_POINT',
    branchCode: 'JED',
    place: 'SARUH',
    nameAr: 'نافذة استلام الرياض - السلي',
    nameEn: 'Riyadh drop-off window - Al Sulay',
    address: 'حي السلي، المنطقة الصناعية، الرياض',
    phone: '+966500000105',
    latitude: '24.588000',
    longitude: '46.833000',
  },
  {
    code: 'TR-CAN-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'DXB',
    place: 'CNCAN',
    nameAr: 'نافذة استلام قوانزو - شياوبي',
    nameEn: 'Guangzhou drop-off window - Xiaobei',
    address: 'منطقة شياوبي، يويشيو، قوانزو',
    phone: '+8613000000402',
    latitude: '23.142000',
    longitude: '113.270000',
  },
  // Pick-up windows in the Sudanese cities NOLON delivers to.
  {
    code: 'TR-PZU-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'PTS',
    place: 'SDPZU',
    nameAr: 'نافذة تسليم بورتسودان - ديم مدينة',
    nameEn: 'Port Sudan pick-up window - Deim Madina',
    address: 'حي ديم مدينة، بورتسودان',
    phone: '+249900000506',
    latitude: '19.603000',
    longitude: '37.207000',
  },
  {
    code: 'TR-ATB-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'ATB',
    place: 'SDATB',
    nameAr: 'نافذة تسليم عطبرة - الداخلة',
    nameEn: 'Atbara pick-up window - Al Dakhla',
    address: 'حي الداخلة، عطبرة',
    phone: '+249900000507',
    latitude: '17.693000',
    longitude: '33.976000',
  },
  {
    code: 'TR-KRT-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'KRT',
    place: 'SDKRT',
    nameAr: 'نافذة تسليم الخرطوم - السوق العربي',
    nameEn: 'Khartoum pick-up window - Souq Al Arabi',
    address: 'السوق العربي، الخرطوم',
    phone: '+249900000508',
    latitude: '15.596000',
    longitude: '32.531000',
  },
  {
    code: 'TR-DOG-W1',
    kind: 'DROP_OFF_POINT',
    branchCode: 'ATB',
    place: 'SDDOG',
    nameAr: 'نافذة تسليم دنقلا - السوق',
    nameEn: 'Dongola pick-up window - Market',
    address: 'قرب السوق الكبير، دنقلا',
    phone: '+249900000509',
    latitude: '19.176000',
    longitude: '30.481000',
  },
];

export interface TrialFacilitiesDeps {
  prisma: PrismaService;
  masterData: MasterDataService;
  warehouses: WarehousesService;
}

/**
 * Adds the trial facilities that are not there yet. Returns what it did and found, one line each.
 */
export async function applyTrialFacilities(
  { prisma, masterData, warehouses }: TrialFacilitiesDeps,
  actor: AuthUser,
): Promise<string[]> {
  const report: string[] = [];
  const say = (line: string) => report.push(line);

  const branches = new Map(
    (await prisma.branch.findMany({ select: { id: true, code: true, isActive: true } })).map(
      (b) => [b.code, b],
    ),
  );
  const placeIds = new Map<string, string>();
  const wanted = new Set(TRIAL_FACILITIES.map((f) => f.place));
  for (const spec of [...SOFT_LAUNCH_PLACES, ...ADDABLE_PLACES].filter((p) => wanted.has(p.code))) {
    const place = await findPlace(prisma, spec, say);
    if (place === null && ADDABLE_PLACES.includes(spec)) {
      const created = await masterData.createLocation(actor, {
        code: spec.code,
        kind: spec.kind,
        nameEn: spec.nameEn,
        nameAr: spec.nameAr,
        countryCode: spec.countryCode,
      });
      say(`مكان جديد: ${spec.nameAr} (${spec.code})`);
      placeIds.set(spec.code, created.id);
      continue;
    }
    if (place === null) say(`مكان ناقص: ${spec.nameAr} (${spec.code})، مراكزه لم تُدخل`);
    else if (place && !place.isActive) {
      say(`مكان موقوف: ${place.nameAr} (${place.code})، مراكزه لم تُدخل`);
    } else if (place) placeIds.set(spec.code, place.id);
  }

  const existing = new Map(
    (
      await prisma.warehouse.findMany({
        where: { code: { in: TRIAL_FACILITIES.map((f) => f.code) } },
        select: { code: true, isActive: true },
      })
    ).map((w) => [w.code, w.isActive]),
  );
  let created = 0;
  for (const f of TRIAL_FACILITIES) {
    const label = `${f.nameAr} (${f.code})`;
    const active = existing.get(f.code);
    if (active !== undefined) {
      say(`موجود، تُرك: ${label}${active ? '' : '، موقوف'}`);
      continue;
    }
    const branch = branches.get(f.branchCode);
    if (!branch || !branch.isActive) {
      say(`فرع ${branch ? 'موقوف' : 'ناقص'}: ${f.branchCode}، ${label} لم يُدخل`);
      continue;
    }
    const locationId = placeIds.get(f.place);
    if (!locationId) continue;
    await warehouses.create(
      actor,
      {
        branchId: branch.id,
        code: f.code,
        nameAr: `${f.nameAr} (تجريبي)`,
        nameEn: `${f.nameEn} (trial)`,
        address: `${TRIAL_ADDRESS_PREFIX}${f.address}`,
        locationId,
      },
      { kind: f.kind, phone: f.phone, latitude: f.latitude, longitude: f.longitude },
    );
    created += 1;
  }
  say(`مراكز جديدة: ${created} من ${TRIAL_FACILITIES.length}`);
  return report;
}
