import { SetMetadata } from '@nestjs/common';
import type { Role } from '../roles.js';

export const ROLES_KEY = 'crm:roles';

/** Limits a route (or a whole controller) to these roles. Without it any signed-in staff may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
