import { Inject, Injectable } from '@nestjs/common';
import { AdminService, AuditAction } from '@modules/admin';
import type { AuthContext } from '@app/rbac';
import { toSessionUser, unauthenticated } from './auth.errors.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import { IamRepository } from './iam.repository.js';
import type { RequestMeta, SessionLookup, SessionUser } from './iam.types.js';
import { TokenService } from './token.service.js';

/**
 * Two tabs often notice an expired access token together and both present the same refresh
 * token. The second one arrives just after the first has replaced it. Within this window that
 * is treated as the same user, not as a stolen token being replayed.
 */
export const REFRESH_GRACE_MS = 10_000;

/** The cookies a refresh sets. Without `refresh` and `csrf`, only the access token is renewed. */
export interface RefreshedTokens {
    access: string;
    refresh?: string;
    csrf?: string;
}

export interface RefreshResult {
    user: SessionUser;
    tokens: RefreshedTokens;
}

/** Keeping a sign-in alive (refresh), ending it (logout) and saying who is signed in (me). */
@Injectable()
export class SessionService {
    constructor(
        private readonly repository: IamRepository,
        private readonly tokens: TokenService,
        private readonly admin: AdminService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    /**
     * Trades a refresh token for a new access token and a new refresh token; the old refresh token
     * stops working. Presenting an old token again, after the grace window, means a copy of it
     * exists somewhere else, so the whole sign-in is ended. Role and password state are read from
     * the database here, so a role change reaches the access token within one refresh.
     */
    async refresh(
        refreshToken: string | undefined,
        meta: RequestMeta,
    ): Promise<RefreshResult> {
        const now = new Date();
        if (!refreshToken) {
            throw unauthenticated();
        }

        const found = await this.repository.findSessionByTokenHash(
            this.tokens.hash(refreshToken),
        );
        if (!found) {
            throw unauthenticated();
        }
        const { session, account } = found;

        if (!account.isActive) {
            await this.repository.revokeFamily(session.familyId, now);
            throw unauthenticated();
        }
        if (session.revokedAt) {
            return this.usedBefore(found, session.revokedAt, meta, now);
        }
        if (session.expiresAt <= now) {
            throw unauthenticated();
        }

        const next = this.tokens.newRefreshToken();
        const csrf = this.tokens.newCsrfToken();
        // Signed before anything is written, so a signing failure leaves the old token usable.
        const access = await this.signAccess(found);

        const rotated = await this.repository.rotateSession(
            session.id,
            account.id,
            {
                tokenHash: next.hash,
                familyId: session.familyId,
                userAgent: meta.userAgent?.slice(0, 255) ?? null,
                ip: meta.ip?.slice(0, 45) ?? null,
                expiresAt: new Date(now.getTime() + this.config.refreshTtlMs),
            },
            now,
        );
        if (!rotated) {
            // Another request replaced this token between our read and our write.
            return this.usedBefore(found, now, meta, now);
        }

        return {
            user: toSessionUser(account),
            tokens: { access, refresh: next.token, csrf },
        };
    }

    /**
     * Ends the sign-in that owns this refresh token. Always succeeds: an unknown, expired or
     * already ended token just means there is nothing left to end.
     */
    async logout(
        refreshToken: string | undefined,
        meta: RequestMeta,
    ): Promise<void> {
        if (!refreshToken) {
            return;
        }
        const found = await this.repository.findSessionByTokenHash(
            this.tokens.hash(refreshToken),
        );
        if (!found) {
            return;
        }

        const ended = await this.repository.revokeFamily(
            found.session.familyId,
            new Date(),
        );
        if (ended > 0) {
            await this.admin.audit({
                action: AuditAction.Logout,
                actorId: found.account.id,
                entityType: 'staff',
                entityId: found.account.publicId,
                ip: meta.ip ?? null,
            });
        }
    }

    /**
     * Who is signed in, from the database rather than the token: a deactivated account, a
     * changed role or a sign-in that has been logged out show up here straight away.
     */
    async me(auth: AuthContext): Promise<SessionUser> {
        const [account, signedIn] = await Promise.all([
            this.repository.findStaffByPublicId(auth.publicId),
            this.repository.familyHasActiveSession(auth.familyId, new Date()),
        ]);
        if (!account || !account.isActive || !signedIn) {
            throw unauthenticated();
        }
        return toSessionUser(account);
    }

    /**
     * A refresh token that has already been replaced. Either another tab used it a moment ago (a
     * new access token is enough: the browser already holds the replacement refresh token), or a
     * stale copy is being replayed (the whole sign-in ends).
     */
    private async usedBefore(
        found: SessionLookup,
        usedAt: Date,
        meta: RequestMeta,
        now: Date,
    ): Promise<RefreshResult> {
        const { session, account } = found;

        // A sign-in that was logged out, or already shut down, has nothing left to protect.
        if (
            !(await this.repository.familyHasActiveSession(
                session.familyId,
                now,
            ))
        ) {
            throw unauthenticated();
        }

        if (now.getTime() - usedAt.getTime() <= REFRESH_GRACE_MS) {
            return {
                user: toSessionUser(account),
                tokens: { access: await this.signAccess(found) },
            };
        }

        await this.repository.revokeFamily(session.familyId, now);
        await this.admin.audit({
            action: AuditAction.RefreshReuseDetected,
            actorId: account.id,
            entityType: 'session',
            entityId: session.familyId,
            ip: meta.ip ?? null,
        });
        throw unauthenticated();
    }

    private signAccess({ session, account }: SessionLookup): Promise<string> {
        return this.tokens.signAccessToken({
            publicId: account.publicId,
            role: account.role,
            familyId: session.familyId,
            mustChangePassword: account.mustChangePassword,
        });
    }
}
