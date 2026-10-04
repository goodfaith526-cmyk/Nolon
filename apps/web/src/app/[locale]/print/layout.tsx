import type { ReactNode } from 'react';
import { PrintShell } from '@/components/print/PrintShell';

/** Printouts: the document alone, without the staff menu (still signed in). */
export default function PrintLayout({ children }: { children: ReactNode }) {
  return <PrintShell>{children}</PrintShell>;
}
