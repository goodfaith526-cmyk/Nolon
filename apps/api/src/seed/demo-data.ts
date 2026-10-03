import { type BranchCode, type CurrencyCode } from '@nolon/shared';

export interface BranchSeed {
  code: BranchCode;
  nameEn: string;
  nameAr: string;
  countryCode: string;
  city: string;
  /** Must exist in the `currencies` master table (foreign key). */
  defaultCurrency: CurrencyCode;
  timezone: string;
}

/**
 * Demo data for staging: the branches. Customers, rates, quotations and bookings are in
 * demo-commercial.ts.
 */
export const DEMO_BRANCHES: readonly BranchSeed[] = [
  {
    code: 'DXB',
    nameEn: 'NOLON Dubai',
    nameAr: 'نولون دبي',
    countryCode: 'AE',
    city: 'Dubai',
    defaultCurrency: 'AED',
    timezone: 'Asia/Dubai',
  },
  {
    code: 'JED',
    nameEn: 'NOLON Jeddah',
    nameAr: 'نولون جدة',
    countryCode: 'SA',
    city: 'Jeddah',
    defaultCurrency: 'SAR',
    timezone: 'Asia/Riyadh',
  },
  {
    code: 'PTS',
    nameEn: 'NOLON Port Sudan',
    nameAr: 'نولون بورتسودان',
    countryCode: 'SD',
    city: 'Port Sudan',
    defaultCurrency: 'SDG',
    timezone: 'Africa/Khartoum',
  },
  {
    code: 'ATB',
    nameEn: 'NOLON Atbara',
    nameAr: 'نولون عطبرة',
    countryCode: 'SD',
    city: 'Atbara',
    defaultCurrency: 'SDG',
    timezone: 'Africa/Khartoum',
  },
  {
    code: 'KRT',
    nameEn: 'NOLON Khartoum',
    nameAr: 'نولون الخرطوم',
    countryCode: 'SD',
    city: 'Khartoum',
    defaultCurrency: 'SDG',
    timezone: 'Africa/Khartoum',
  },
];
