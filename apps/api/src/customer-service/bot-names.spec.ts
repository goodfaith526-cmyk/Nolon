import { describe, expect, it } from 'vitest';
import { fold, matchCategory, matchPlace } from './bot-names.js';

const place = (id: string, nameAr: string, nameEn: string, extra = {}) => ({
  id,
  kind: 'CITY',
  nameAr,
  nameEn,
  cityId: null,
  aliases: [] as string[],
  ...extra,
});

describe('bot names', () => {
  it('folds case, spacing and Arabic letter forms', () => {
    expect(fold('  Port   Sudan ')).toBe('port sudan');
    expect(fold('جدّة')).toBe(fold('جده'));
    expect(fold('إمارات')).toBe(fold('امارات'));
    expect(fold('مستشفى')).toBe(fold('مستشفي'));
  });

  it('matches one place by either name or an alias, a city over its own places', () => {
    const city = place('c', 'جدة', 'Jeddah');
    const port = place('p', 'جدة', 'Jeddah', { kind: 'PORT', cityId: 'c' });
    const other = place('o', 'الخرطوم', 'Khartoum', { aliases: ['KRT'] });
    expect(matchPlace({ ar: 'جده', en: '' }, [city, port, other])).toBe('c');
    expect(matchPlace({ ar: '؟', en: 'krt' }, [city, port, other])).toBe('o');
    expect(matchPlace({ ar: 'مكة', en: 'Makkah' }, [city, other])).toBeNull();
    // Two unrelated places of one name: staff choose.
    const twin = place('t', 'جدة', 'Jeddah');
    expect(matchPlace({ ar: 'جدة', en: 'Jeddah' }, [city, twin])).toBeNull();
    // The Arabic name one place's, the English another's: staff choose.
    expect(matchPlace({ ar: 'جدة', en: 'Khartoum' }, [city, other])).toBeNull();
  });

  it('matches one shipment type by code or name', () => {
    const types = [
      { code: 'BARREL', nameAr: 'برميل', nameEn: 'Barrel' },
      { code: 'CARTON', nameAr: 'كرتونة', nameEn: 'Carton' },
    ];
    expect(matchCategory({ ar: 'برميل', en: 'barrel' }, types)).toBe('BARREL');
    expect(matchCategory({ ar: '', en: 'carton' }, types)).toBe('CARTON');
    expect(matchCategory({ ar: 'شنطة', en: 'Bag' }, types)).toBeNull();
  });
});
