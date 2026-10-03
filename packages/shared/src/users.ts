import type { Role } from './auth.js';
import type { Locale } from './locales.js';

/** Minimum length for staff passwords (sign-in, user creation, password reset). */
export const MIN_PASSWORD_LENGTH = 12;

/** Upper bound, so a huge input cannot make password hashing expensive. */
export const MAX_PASSWORD_LENGTH = 200;

/** One row of GET /users. */
export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  preferredLocale: string;
  isActive: boolean;
  lastLoginAt: string | null;
  roles: Role[];
  branchIds: string[];
}

/** Body of POST /users. */
export interface CreateUserRequest {
  email: string;
  fullName: string;
  password: string;
  preferredLocale: Locale;
  roles: Role[];
  branchIds: string[];
}

/** Body of PATCH /users/:id. Omitted fields stay as they are. */
export interface UpdateUserRequest {
  fullName?: string;
  preferredLocale?: Locale;
  roles?: Role[];
  branchIds?: string[];
}

/** Body of POST /users/:id/password (admin reset). */
export interface ResetPasswordRequest {
  password: string;
}

/** Body of POST /auth/password (the signed-in user changes their own password). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
