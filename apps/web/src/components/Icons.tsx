import type { ReactNode } from 'react';

/** Small line icons (24px grid, currentColor). Inline SVG: no icon dependency. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const icons = {
  home: (
    <Icon>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </Icon>
  ),
  customers: (
    <Icon>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M18 14.8c2 .7 3.2 2.5 3.5 5.2" />
    </Icon>
  ),
  rates: (
    <Icon>
      <path d="M3 12V4h8l10 10-8 8L3 12Z" />
      <circle cx="7.5" cy="8.5" r="1.5" />
    </Icon>
  ),
  quotations: (
    <Icon>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h7M9 17h5" />
    </Icon>
  ),
  bookings: (
    <Icon>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="m9 15 2 2 4-4" />
    </Icon>
  ),
  users: (
    <Icon>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" />
    </Icon>
  ),
  account: (
    <Icon>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </Icon>
  ),
  signOut: (
    <Icon>
      <path d="M14 4h5v16h-5" />
      <path d="M10 8l-4 4 4 4M6 12h10" />
    </Icon>
  ),
  menu: (
    <Icon>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  ),
  globe: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  warehouse: (
    <Icon>
      <path d="M3 9.5 12 4l9 5.5V20H3z" />
      <path d="M7 20v-7h10v7" />
      <path d="M7 16.5h10" />
    </Icon>
  ),
  truck: (
    <Icon>
      <path d="M2.5 6h11v10h-11z" />
      <path d="M13.5 9.5h4l3 3.5v3h-7" />
      <circle cx="6.5" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </Icon>
  ),
  vehicle: (
    <Icon>
      <path d="M4 16V9l2.5-4h11L20 9v7" />
      <path d="M3 16h18v2H3z" />
      <circle cx="7.5" cy="12.5" r="1" />
      <circle cx="16.5" cy="12.5" r="1" />
    </Icon>
  ),
  driver: (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 14v6.5M10.2 11 4 9.5M13.8 11 20 9.5" />
    </Icon>
  ),
  carrier: (
    <Icon>
      <path d="M3 20V8l6-3v15M9 9h12v11H3" />
      <path d="M12.5 13h2M16.5 13h2M12.5 16.5h2M16.5 16.5h2" />
    </Icon>
  ),
  ship: (
    <Icon>
      <path d="M3 17c1.5 1.3 3 2 4.5 2S10.5 18.3 12 17c1.5 1.3 3 2 4.5 2s3-.7 4.5-2" />
      <path d="M5 15 4 10h16l-1 5" />
      <path d="M8 10V6h8v4M12 3v3" />
    </Icon>
  ),
  invoice: (
    <Icon>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Icon>
  ),
  receipt: (
    <Icon>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9.5v5M18 9.5v5" />
    </Icon>
  ),
  journal: (
    <Icon>
      <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
      <path d="M5 18a2 2 0 0 1 2-2h12" />
      <path d="M9 8h6M9 11h4" />
    </Icon>
  ),
  balance: (
    <Icon>
      <path d="M12 4v16M7 20h10M5 7h14" />
      <path d="m5 7-2.5 6a3 3 0 0 0 5 0z" />
      <path d="m19 7-2.5 6a3 3 0 0 0 5 0z" />
    </Icon>
  ),
  accounts: (
    <Icon>
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <rect x="3" y="17" width="6" height="4" rx="1" />
      <rect x="15" y="17" width="6" height="4" rx="1" />
      <path d="M12 7v5M6 17v-5h12v5" />
    </Icon>
  ),
  exchange: (
    <Icon>
      <path d="M4 8h14l-3-3M20 16H6l3 3" />
    </Icon>
  ),
  calendar: (
    <Icon>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M8 14h3v3H8z" />
    </Icon>
  ),
} as const;
