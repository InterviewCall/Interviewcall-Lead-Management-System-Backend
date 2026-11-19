import argon2 from 'argon2';
import { type AdminService, AuditAction } from '@modules/admin';
import type { NotificationService } from '@notifications';
import { loadIamConfig } from './iam.config.js';
import type { IamRepository } from './iam.repository.js';
import type { StaffAccount, StaffRecord } from './iam.types.js';
import { PasswordService } from './password.service.js';
import { StaffService } from './staff.service.js';

/** JSON.stringify that copes with the bigint ids in audit entries. */
const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
    );

describe('StaffService', () => {
    const config = loadIamConfig({
        ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
        CRM_WEB_ORIGIN: 'https://crm.interviewcall.club/',
    });
    const repository = {
        createStaff: vi.fn(),
        deleteStaff: vi.fn(),
        findStaffByPublicId: vi.fn(),
        setTemporaryPassword: vi.fn(),
        listStaff: vi.fn(),
        updateStaff: vi.fn(),
        deactivateStaff: vi.fn(),
        reactivateStaff: vi.fn(),
        phoneInUse: vi.fn(),
    };
    const notifications = { enqueue: vi.fn() };
    const admin = { audit: vi.fn() };
    let service: StaffService;

    const adminAccount: StaffAccount = {
        id: 1n,
        publicId: '11111111-1111-4111-8111-111111111111',
        name: 'Admin',
        email: 'admin@example.com',
        passwordHash: 'hash',
        role: 'ADMIN',
        isActive: true,
        mustChangePassword: false,
        lockedUntil: null,
        phone: '+919000000001',
    };
    const auth = {
        publicId: adminAccount.publicId,
        role: 'ADMIN' as const,
        familyId: 'f',
        mustChangePassword: false,
    };
    const meta = { ip: '203.0.113.9', userAgent: undefined };

    const created: StaffRecord = {
        id: 11n,
        publicId: '0c4c59f3-1b0e-4f55-9a43-0c1a0d0d7c11',
        name: 'Ravi Kumar',
        email: 'ravi@example.com',
        phone: '+919876543210',
        role: 'SALES_MANAGER',
        isActive: true,
        mustChangePassword: true,
    };
    const target: StaffAccount = {
        ...created,
        passwordHash: 'old-hash',
        mustChangePassword: false,
        lockedUntil: null,
    };
    const input = {
        name: 'Ravi Kumar',
        email: 'ravi@example.com',
        phone: '+919876543210',
        role: 'SALES_MANAGER' as const,
    };

    const auditActions = () =>
        admin.audit.mock.calls.map(([entry]) => entry.action);

    beforeEach(() => {
        vi.resetAllMocks();
        const accounts = new Map<string, StaffAccount>([
            [adminAccount.publicId, adminAccount],
            [target.publicId, target],
        ]);
        repository.findStaffByPublicId.mockImplementation(
            async (id: string) => accounts.get(id) ?? null,
        );
        repository.phoneInUse.mockResolvedValue(false);
        repository.createStaff.mockResolvedValue(created);
        repository.deleteStaff.mockResolvedValue(undefined);
        repository.setTemporaryPassword.mockResolvedValue(undefined);
        notifications.enqueue.mockResolvedValue(undefined);
        service = new StaffService(
            repository as unknown as IamRepository,
            new PasswordService(),
            notifications as unknown as NotificationService,
            admin as unknown as AdminService,
            config,
        );
    });

    describe('who may call', () => {
        it('stops a caller whose account is gone or deactivated (401)', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...adminAccount,
                isActive: false,
            });

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                status: 401,
            });
            expect(repository.createStaff).not.toHaveBeenCalled();
        });

        it('stops a caller who is no longer an admin even if the token says so (403)', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...adminAccount,
                role: 'BDA',
            });

            await expect(
                service.list(auth, { page: 1, pageSize: 25 }),
            ).rejects.toMatchObject({
                status: 403,
                response: { code: 'FORBIDDEN' },
            });
            expect(repository.listStaff).not.toHaveBeenCalled();
        });
    });

    describe('create', () => {
        it('stores a hash of a one-time password and emails that same password', async () => {
            await service.create(auth, input, meta);

            const stored = repository.createStaff.mock.calls[0][0];
            const message = notifications.enqueue.mock.calls[0][0];
            expect(stored).toMatchObject(input);
            expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
            expect(message.data.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
            await expect(
                argon2.verify(
                    stored.passwordHash,
                    message.data.temporaryPassword,
                ),
            ).resolves.toBe(true);
        });

        it('emails the invite template to the new address with a sign-in link', async () => {
            await service.create(auth, input, meta);

            expect(notifications.enqueue).toHaveBeenCalledWith({
                channel: 'EMAIL',
                recipient: 'ravi@example.com',
                template: 'staff-invite',
                data: {
                    name: 'Ravi Kumar',
                    role: 'Sales Manager',
                    email: 'ravi@example.com',
                    temporaryPassword: expect.any(String),
                    loginUrl: 'https://crm.interviewcall.club/login',
                },
            });
        });

        it('returns the account as PENDING and never the password or its hash', async () => {
            const view = await service.create(auth, input, meta);

            expect(view).toEqual({
                id: created.publicId,
                name: 'Ravi Kumar',
                email: 'ravi@example.com',
                phone: '+919876543210',
                role: 'SALES_MANAGER',
                status: 'PENDING',
            });
            const stored = repository.createStaff.mock.calls[0][0];
            const sent =
                notifications.enqueue.mock.calls[0][0].data.temporaryPassword;
            expect(JSON.stringify(view)).not.toContain(sent);
            expect(JSON.stringify(view)).not.toContain(stored.passwordHash);
        });

        it('records who created whom, by id and role only', async () => {
            await service.create(auth, input, meta);

            expect(admin.audit).toHaveBeenCalledWith({
                action: AuditAction.StaffCreated,
                actorId: 1n,
                entityType: 'staff',
                entityId: created.publicId,
                detail: { role: 'SALES_MANAGER' },
                ip: '203.0.113.9',
            });
            expect(json(admin.audit.mock.calls)).not.toContain(
                'ravi@example.com',
            );
        });

        it('answers 409 for a taken email and sends nothing', async () => {
            repository.createStaff.mockResolvedValue(null);

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'EMAIL_ALREADY_EXISTS' },
            });
            expect(notifications.enqueue).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('answers 409 for a phone number another person already has, and creates nothing', async () => {
            repository.phoneInUse.mockResolvedValue(true);

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                status: 409,
                response: {
                    code: 'PHONE_ALREADY_IN_USE',
                    fields: { phone: expect.any(String) },
                },
            });
            expect(repository.createStaff).not.toHaveBeenCalled();
            expect(notifications.enqueue).not.toHaveBeenCalled();
        });

        it('blames the phone, not the email, when two admins save the same number at once', async () => {
            repository.phoneInUse
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            repository.createStaff.mockResolvedValue(null);

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                response: { code: 'PHONE_ALREADY_IN_USE' },
            });
        });

        it('never puts the phone number in the audit entry', async () => {
            await service.create(auth, input, meta);

            expect(json(admin.audit.mock.calls)).not.toContain('9876543210');
        });

        it('removes the account again when the email cannot be queued, and records nothing', async () => {
            notifications.enqueue.mockRejectedValue(
                new Error('Notification queue is not connected'),
            );

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                status: 503,
                response: { code: 'EMAIL_QUEUE_UNAVAILABLE' },
            });
            expect(repository.deleteStaff).toHaveBeenCalledWith(11n);
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('still answers 503 if removing the account also fails', async () => {
            notifications.enqueue.mockRejectedValue(new Error('down'));
            repository.deleteStaff.mockRejectedValue(new Error('db down'));

            await expect(
                service.create(auth, input, meta),
            ).rejects.toMatchObject({
                status: 503,
            });
        });
    });

    describe('list', () => {
        it('returns a page with dates as text and the paging it was given', async () => {
            repository.listStaff.mockResolvedValue({
                items: [
                    {
                        ...created,
                        mustChangePassword: false,
                        createdAt: new Date('2026-10-01T00:00:00.000Z'),
                        lastLoginAt: null,
                    },
                ],
                total: 41,
            });

            const result = await service.list(auth, {
                page: 2,
                pageSize: 25,
                search: 'rav',
            });

            expect(repository.listStaff).toHaveBeenCalledWith({
                page: 2,
                pageSize: 25,
                search: 'rav',
            });
            expect(result).toEqual({
                staff: [
                    {
                        id: created.publicId,
                        name: 'Ravi Kumar',
                        email: 'ravi@example.com',
                        phone: '+919876543210',
                        role: 'SALES_MANAGER',
                        status: 'ACTIVE',
                        createdAt: '2026-10-01T00:00:00.000Z',
                        lastLoginAt: null,
                    },
                ],
                page: 2,
                pageSize: 25,
                total: 41,
            });
        });

        it('treats an empty search as no search', async () => {
            repository.listStaff.mockResolvedValue({ items: [], total: 0 });

            await service.list(auth, { page: 1, pageSize: 25, search: '' });

            expect(
                repository.listStaff.mock.calls[0][0].search,
            ).toBeUndefined();
        });
    });

    describe('update', () => {
        beforeEach(() => {
            repository.updateStaff.mockImplementation(
                async (_id: bigint, changes: object) => ({
                    ...created,
                    mustChangePassword: false,
                    ...changes,
                }),
            );
        });

        it('changes the name and the role, and records which fields changed', async () => {
            const view = await service.update(
                auth,
                target.publicId,
                { name: 'Ravi K', role: 'CLOSER' },
                meta,
            );

            expect(repository.updateStaff).toHaveBeenCalledWith(11n, {
                name: 'Ravi K',
                role: 'CLOSER',
            });
            expect(view).toMatchObject({ name: 'Ravi K', role: 'CLOSER' });
            expect(admin.audit).toHaveBeenCalledWith({
                action: AuditAction.StaffUpdated,
                actorId: 1n,
                entityType: 'staff',
                entityId: target.publicId,
                detail: {
                    fields: ['name', 'role'],
                    role: { from: 'SALES_MANAGER', to: 'CLOSER' },
                },
                ip: '203.0.113.9',
            });
            expect(json(admin.audit.mock.calls)).not.toContain('Ravi K');
        });

        it('does nothing, and records nothing, when nothing differs', async () => {
            const view = await service.update(
                auth,
                target.publicId,
                { name: 'Ravi Kumar', role: 'SALES_MANAGER' },
                meta,
            );

            expect(view.status).toBe('ACTIVE');
            expect(repository.updateStaff).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('lets an admin rename themselves but not change their own role (409)', async () => {
            await service.update(
                auth,
                adminAccount.publicId,
                { name: 'Boss' },
                meta,
            );
            expect(repository.updateStaff).toHaveBeenCalledWith(1n, {
                name: 'Boss',
            });

            await expect(
                service.update(
                    auth,
                    adminAccount.publicId,
                    { role: 'BDA' },
                    meta,
                ),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'CANNOT_CHANGE_OWN_ROLE' },
            });
        });

        it('changes the phone number and records only that the phone changed', async () => {
            const view = await service.update(
                auth,
                target.publicId,
                { phone: '+919111111111' },
                meta,
            );

            expect(repository.phoneInUse).toHaveBeenCalledWith(
                '+919111111111',
                11n,
            );
            expect(repository.updateStaff).toHaveBeenCalledWith(11n, {
                phone: '+919111111111',
            });
            expect(view).toMatchObject({ phone: '+919111111111' });
            expect(json(admin.audit.mock.calls)).toContain('"phone"');
            expect(json(admin.audit.mock.calls)).not.toContain('9111111111');
        });

        it('answers 409 when the new phone number belongs to someone else', async () => {
            repository.phoneInUse.mockResolvedValue(true);

            await expect(
                service.update(
                    auth,
                    target.publicId,
                    { phone: '+919111111111' },
                    meta,
                ),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'PHONE_ALREADY_IN_USE' },
            });
            expect(repository.updateStaff).not.toHaveBeenCalled();
        });

        it('does nothing when the phone number is the one already saved', async () => {
            await service.update(
                auth,
                target.publicId,
                { phone: '+919876543210' },
                meta,
            );

            expect(repository.updateStaff).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('answers 404 for an unknown account', async () => {
            await expect(
                service.update(
                    auth,
                    '99999999-9999-4999-8999-999999999999',
                    { name: 'X Y' },
                    meta,
                ),
            ).rejects.toMatchObject({
                status: 404,
                response: { code: 'STAFF_NOT_FOUND' },
            });
        });
    });

    describe('updateOwnProfile', () => {
        // A manager: not an admin, so the admin staff screen is closed to them.
        const manager: StaffAccount = {
            ...target,
            id: 21n,
            publicId: '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d21',
            role: 'SALES_MANAGER',
            phone: null,
        };
        const managerAuth = {
            publicId: manager.publicId,
            role: 'SALES_MANAGER' as const,
            familyId: 'f',
            mustChangePassword: false,
        };

        beforeEach(() => {
            repository.findStaffByPublicId.mockImplementation(
                async (id: string) =>
                    id === manager.publicId ? manager : null,
            );
            repository.updateStaff.mockImplementation(
                async (_id: bigint, changes: object) => ({
                    ...manager,
                    ...changes,
                }),
            );
        });

        it('lets a non-admin save their own phone number and returns the refreshed session user', async () => {
            const user = await service.updateOwnProfile(
                managerAuth,
                { phone: '+919222222222' },
                meta,
            );

            expect(repository.phoneInUse).toHaveBeenCalledWith(
                '+919222222222',
                21n,
            );
            expect(repository.updateStaff).toHaveBeenCalledWith(21n, {
                phone: '+919222222222',
            });
            expect(user).toMatchObject({
                id: manager.publicId,
                role: 'SALES_MANAGER',
                phone: '+919222222222',
            });
            expect(JSON.stringify(user)).not.toContain('hash');
        });

        it('records that the person changed their own phone, without the number', async () => {
            await service.updateOwnProfile(
                managerAuth,
                { phone: '+919222222222' },
                meta,
            );

            expect(admin.audit).toHaveBeenCalledWith({
                action: AuditAction.StaffUpdated,
                actorId: 21n,
                entityType: 'staff',
                entityId: manager.publicId,
                detail: { fields: ['phone'], self: true },
                ip: '203.0.113.9',
            });
            expect(json(admin.audit.mock.calls)).not.toContain('9222222222');
        });

        it('answers 409 when the number belongs to a colleague', async () => {
            repository.phoneInUse.mockResolvedValue(true);

            await expect(
                service.updateOwnProfile(
                    managerAuth,
                    { phone: '+919222222222' },
                    meta,
                ),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'PHONE_ALREADY_IN_USE' },
            });
            expect(repository.updateStaff).not.toHaveBeenCalled();
        });

        it('does nothing when the number is unchanged', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...manager,
                phone: '+919222222222',
            });

            const user = await service.updateOwnProfile(
                managerAuth,
                { phone: '+919222222222' },
                meta,
            );

            expect(user.phone).toBe('+919222222222');
            expect(repository.updateStaff).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('stops a deactivated account (401)', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...manager,
                isActive: false,
            });

            await expect(
                service.updateOwnProfile(
                    managerAuth,
                    { phone: '+919222222222' },
                    meta,
                ),
            ).rejects.toMatchObject({ status: 401 });
            expect(repository.updateStaff).not.toHaveBeenCalled();
        });
    });

    describe('deactivate', () => {
        beforeEach(() => {
            repository.deactivateStaff.mockResolvedValue({
                ...created,
                mustChangePassword: false,
                isActive: false,
            });
        });

        it('switches the account off, ends its sessions and records it', async () => {
            const view = await service.deactivate(auth, target.publicId, meta);

            expect(repository.deactivateStaff).toHaveBeenCalledWith(
                11n,
                expect.any(Date),
            );
            expect(view.status).toBe('DEACTIVATED');
            expect(auditActions()).toEqual([AuditAction.StaffDeactivated]);
        });

        it('refuses to deactivate yourself (409)', async () => {
            await expect(
                service.deactivate(auth, adminAccount.publicId, meta),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'CANNOT_DEACTIVATE_SELF' },
            });
            expect(repository.deactivateStaff).not.toHaveBeenCalled();
        });

        it('does nothing to an account that is already deactivated', async () => {
            repository.findStaffByPublicId.mockImplementation(
                async (id: string) =>
                    id === target.publicId
                        ? { ...target, isActive: false }
                        : adminAccount,
            );

            const view = await service.deactivate(auth, target.publicId, meta);

            expect(view.status).toBe('DEACTIVATED');
            expect(repository.deactivateStaff).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });
    });

    describe('reactivate', () => {
        const off: StaffAccount = { ...target, isActive: false };

        beforeEach(() => {
            repository.findStaffByPublicId.mockImplementation(
                async (id: string) =>
                    id === target.publicId ? off : adminAccount,
            );
            repository.reactivateStaff.mockResolvedValue({
                ...created,
                isActive: true,
                mustChangePassword: true,
            });
        });

        it('switches it on with a new one-time password and emails that password', async () => {
            const view = await service.reactivate(auth, target.publicId, meta);

            const [userId, hash] = repository.reactivateStaff.mock.calls[0];
            const message = notifications.enqueue.mock.calls[0][0];
            expect(userId).toBe(11n);
            await expect(
                argon2.verify(hash, message.data.temporaryPassword),
            ).resolves.toBe(true);
            expect(view.status).toBe('PENDING');
            expect(auditActions()).toEqual([AuditAction.StaffReactivated]);
        });

        it('refuses an account that is already active, so a live password is never replaced (409)', async () => {
            repository.findStaffByPublicId.mockImplementation(
                async (id: string) =>
                    id === target.publicId ? target : adminAccount,
            );

            await expect(
                service.reactivate(auth, target.publicId, meta),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'STAFF_ALREADY_ACTIVE' },
            });
            expect(repository.reactivateStaff).not.toHaveBeenCalled();
        });

        it('puts the account back to deactivated when the email cannot be queued', async () => {
            notifications.enqueue.mockRejectedValue(new Error('down'));
            repository.deactivateStaff.mockResolvedValue(undefined);

            await expect(
                service.reactivate(auth, target.publicId, meta),
            ).rejects.toMatchObject({
                status: 503,
                response: { code: 'EMAIL_QUEUE_UNAVAILABLE' },
            });
            expect(repository.deactivateStaff).toHaveBeenCalledWith(
                11n,
                expect.any(Date),
            );
            expect(admin.audit).not.toHaveBeenCalled();
        });
    });

    describe('resetPassword', () => {
        it('replaces the password, then emails the new one', async () => {
            const view = await service.resetPassword(
                auth,
                target.publicId,
                meta,
            );

            const [userId, hash] =
                repository.setTemporaryPassword.mock.calls[0];
            const message = notifications.enqueue.mock.calls[0][0];
            expect(userId).toBe(11n);
            await expect(
                argon2.verify(hash, message.data.temporaryPassword),
            ).resolves.toBe(true);
            expect(message.template).toBe('staff-invite');
            expect(view.status).toBe('PENDING');
            expect(auditActions()).toEqual([AuditAction.StaffPasswordReset]);
        });

        it('answers 404 for an unknown account', async () => {
            await expect(
                service.resetPassword(
                    auth,
                    '99999999-9999-4999-8999-999999999999',
                    meta,
                ),
            ).rejects.toMatchObject({
                status: 404,
                response: { code: 'STAFF_NOT_FOUND' },
            });
            expect(repository.setTemporaryPassword).not.toHaveBeenCalled();
        });

        it('answers 409 for a deactivated account', async () => {
            repository.findStaffByPublicId.mockImplementation(
                async (id: string) =>
                    id === target.publicId
                        ? { ...target, isActive: false }
                        : adminAccount,
            );

            await expect(
                service.resetPassword(auth, target.publicId, meta),
            ).rejects.toMatchObject({
                status: 409,
                response: { code: 'STAFF_DEACTIVATED' },
            });
            expect(notifications.enqueue).not.toHaveBeenCalled();
        });

        it('answers 503 when queuing fails, but still records the reset that happened', async () => {
            notifications.enqueue.mockRejectedValue(new Error('down'));

            await expect(
                service.resetPassword(auth, target.publicId, meta),
            ).rejects.toMatchObject({
                status: 503,
                response: { code: 'EMAIL_QUEUE_UNAVAILABLE' },
            });
            expect(repository.deleteStaff).not.toHaveBeenCalled();
            expect(auditActions()).toEqual([AuditAction.StaffPasswordReset]);
        });
    });
});
