import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { IamService } from '@modules/iam';
import { LeadsRepository } from './leads.repository.js';
import { type CreateSavedViewBody, MAX_SAVED_VIEWS } from './leads.schemas.js';

interface SavedViewRow {
    id: bigint;
    name: string;
    filters: unknown;
    isShared: boolean;
    userId: bigint;
    user: { name: string };
}

/** A person's own filter sets for the leads list, plus the ones a manager shared with everyone. */
@Injectable()
export class SavedViewsService {
    constructor(
        private readonly repository: LeadsRepository,
        private readonly iam: IamService,
    ) {}

    private async me(auth: AuthContext) {
        const staff = await this.iam.getStaffRef(auth.publicId);
        if (!staff) throw new ForbiddenException({ code: 'NO_ACCOUNT', message: 'Sign in again' });
        return staff;
    }

    private view(row: SavedViewRow, meId: bigint) {
        return {
            id: String(row.id),
            name: row.name,
            filters: row.filters as Record<string, unknown>,
            shared: row.isShared,
            mine: row.userId === meId,
            by: row.user.name,
        };
    }

    async list(auth: AuthContext) {
        const me = await this.me(auth);
        const rows = await this.repository.listSavedViews(me.id);
        return { views: rows.map((r) => this.view(r, me.id)) };
    }

    async create(auth: AuthContext, body: CreateSavedViewBody) {
        const me = await this.me(auth);
        if (body.shared && auth.role !== 'ADMIN' && auth.role !== 'SALES_MANAGER') {
            throw new ForbiddenException({ code: 'SHARE_NOT_ALLOWED', message: 'Only managers and admins can share a view' });
        }
        if ((await this.repository.countSavedViews(me.id)) >= MAX_SAVED_VIEWS) {
            throw new ConflictException({ code: 'TOO_MANY_VIEWS', message: `You can keep ${MAX_SAVED_VIEWS} saved views. Delete one first` });
        }
        if (await this.repository.savedViewNameTaken(me.id, body.name)) {
            throw new ConflictException({ code: 'VIEW_EXISTS', message: 'You already have a view with this name' });
        }
        const row = await this.repository.createSavedView({ userId: me.id, name: body.name, filters: body.filters, isShared: body.shared });
        return this.view(row, me.id);
    }

    /** The owner can delete a view; an admin can delete any. */
    async remove(auth: AuthContext, id: number): Promise<void> {
        const me = await this.me(auth);
        const row = await this.repository.findSavedView(BigInt(id));
        if (!row) throw new NotFoundException({ code: 'VIEW_NOT_FOUND', message: 'This view no longer exists' });
        if (row.userId !== me.id && auth.role !== 'ADMIN') {
            throw new ForbiddenException({ code: 'VIEW_NOT_YOURS', message: 'You can only delete your own views' });
        }
        await this.repository.deleteSavedView(row.id);
    }
}
