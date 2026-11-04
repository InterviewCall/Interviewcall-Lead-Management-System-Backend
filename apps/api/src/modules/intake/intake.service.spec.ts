import { BadRequestException, ConflictException } from '@nestjs/common';
import { IntakeService } from './intake.service.js';
import { MAX_ATTEMPTS } from './intake.constants.js';

const OWNER = { id: 1n, publicId: 'owner-public', name: 'Ada Admin', role: 'ADMIN', isActive: true };

function build(overrides: { importLead?: unknown; claim?: unknown } = {}) {
    const repository = {
        insertEvent: vi.fn().mockResolvedValue({ id: 7n, duplicate: false }),
        claim: vi.fn().mockResolvedValue(
            overrides.claim ?? {
                id: 7n,
                eventId: 'workr-signup-12',
                source: 'WORKR',
                type: 'workr.signup',
                occurredAt: new Date('2026-11-05T05:00:00Z'),
                attempts: 1,
                payload: { userId: 12, fullName: 'Asha Rao', email: 'asha@example.com', phoneNo: '9876543210', details: 'Working Professional' },
            },
        ),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markDead: vi.fn().mockResolvedValue(undefined),
        findDue: vi.fn().mockResolvedValue([]),
        purgePayloads: vi.fn().mockResolvedValue(0),
        reset: vi.fn(),
    };
    const queue = { enqueue: vi.fn().mockResolvedValue(true) };
    const leads = {
        listSources: vi.fn().mockResolvedValue([{ id: 3, name: 'WorkR', group: 'WORKR' }]),
        createList: vi.fn().mockResolvedValue({ id: 5n, publicId: 'list-public', name: 'WorkR signups · 5 Nov 2026' }),
        importLead: vi.fn().mockResolvedValue(overrides.importLead ?? { kind: 'CREATED', leadId: 100n, resumed: false }),
    };
    const pipeline = { openOpportunity: vi.fn().mockResolvedValue({ opportunityId: 1n, publicId: 'opp', created: true }) };
    const assignment = { recordSystemAssignment: vi.fn().mockResolvedValue(undefined) };
    const timeline = { append: vi.fn().mockResolvedValue(undefined), appendMany: vi.fn().mockResolvedValue(undefined), appendOnce: vi.fn() };
    const iam = {
        listActiveStaff: vi.fn().mockResolvedValue([OWNER]),
        getActiveStaffByEmail: vi.fn(),
    };
    const service = new IntakeService(
        repository as never,
        queue as never,
        leads as never,
        pipeline as never,
        assignment as never,
        timeline as never,
        iam as never,
        { apply: vi.fn() } as never,
    );
    return { service, repository, queue, leads, pipeline, assignment, timeline, iam };
}

const signup = {
    eventId: 'workr-signup-12',
    type: 'workr.signup',
    occurredAt: new Date('2026-11-05T05:00:00Z'),
    payload: { userId: 12, fullName: 'Asha Rao', email: 'asha@example.com', phoneNo: '9876543210', details: 'Working Professional' },
};

describe('IntakeService.receive', () => {
    it('stores a valid WorkR signup and queues it', async () => {
        const { service, repository, queue } = build();
        await expect(service.receive('WORKR', signup)).resolves.toEqual({ id: '7', duplicate: false });
        expect(repository.insertEvent).toHaveBeenCalledOnce();
        expect(queue.enqueue).toHaveBeenCalledWith(7n);
    });

    it('does not queue a repeat of an event it already has', async () => {
        const { service, repository, queue } = build();
        repository.insertEvent.mockResolvedValue({ id: 7n, duplicate: true });
        await expect(service.receive('WORKR', signup)).resolves.toEqual({ id: '7', duplicate: true });
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('refuses an event type the key may not send', async () => {
        const { service } = build();
        await expect(service.receive('VSL_FORM', signup)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.receive('WORKR', { ...signup, type: 'vsl.slot_booked' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a payload that is not valid and names the field', async () => {
        const { service, repository } = build();
        const bad = { ...signup, payload: { ...signup.payload, email: 'not-an-email' } };
        await expect(service.receive('WORKR', bad)).rejects.toMatchObject({
            response: { code: 'PAYLOAD_INVALID', fields: { email: expect.any(String) } },
        });
        expect(repository.insertEvent).not.toHaveBeenCalled();
    });
});

describe('IntakeService.process', () => {
    it('makes a lead owned by the intake owner, in the day list, at the first stage', async () => {
        const { service, leads, pipeline, assignment, timeline, repository } = build();
        await service.process(7n);

        expect(leads.createList).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'WorkR signups · 5 Nov 2026', originRef: 'workr-day:2026-11-05', createdById: 1n }),
        );
        expect(leads.importLead).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerId: 1n,
                listId: 5n,
                sourceId: 3,
                ref: 'workr:signup:12',
                kind: 'SIGNUP',
                fields: expect.objectContaining({ email: 'asha@example.com', phoneLast10: '9876543210', userType: 'WORKING_PROFESSIONAL' }),
            }),
        );
        expect(pipeline.openOpportunity).toHaveBeenCalledWith({ leadId: 100n, ownerId: 1n, actorId: null });
        expect(assignment.recordSystemAssignment).toHaveBeenCalled();
        expect(timeline.appendMany).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ type: 'LEAD_CREATED', data: expect.objectContaining({ via: 'WORKR' }) })]),
        );
        expect(repository.markProcessed).toHaveBeenCalledWith(7n, expect.objectContaining({ leadId: 100n, outcome: 'CREATED' }));
    });

    it('uses the day the person signed up, not the day it is processed', async () => {
        const { service, leads } = build({
            claim: {
                id: 7n, eventId: 'x', source: 'WORKR', type: 'workr.signup', attempts: 1,
                occurredAt: new Date('2026-11-04T20:30:00Z'), // 02:00 on 5 Nov in India
                payload: signup.payload,
            },
        });
        await service.process(7n);
        expect(leads.createList).toHaveBeenCalledWith(expect.objectContaining({ originRef: 'workr-day:2026-11-05' }));
    });

    it('ignores a student without creating anything', async () => {
        const { service, leads, repository } = build({
            claim: {
                id: 7n, eventId: 'x', source: 'WORKR', type: 'workr.signup', attempts: 1, occurredAt: new Date(),
                payload: { ...signup.payload, details: 'Student' },
            },
        });
        await service.process(7n);
        expect(leads.importLead).not.toHaveBeenCalled();
        expect(repository.markProcessed).toHaveBeenCalledWith(7n, expect.objectContaining({ leadId: null, outcome: 'IGNORED' }));
    });

    it('leaves the owner and the list of a person who is already a lead alone', async () => {
        const { service, timeline, pipeline, assignment, repository } = build({
            importLead: { kind: 'MATCHED', match: { leadId: 55n }, matchedOn: ['EMAIL'], filled: [], resumed: false },
        });
        await service.process(7n);
        expect(pipeline.openOpportunity).not.toHaveBeenCalled();
        expect(assignment.recordSystemAssignment).not.toHaveBeenCalled();
        expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ leadId: 55n, type: 'TOUCHPOINT_ADDED' }));
        expect(repository.markProcessed).toHaveBeenCalledWith(7n, expect.objectContaining({ leadId: 55n, outcome: 'MATCHED' }));
    });

    it('marks an email and phone that belong to two leads as dead, for a person to merge', async () => {
        const { service, repository, queue } = build({ importLead: { kind: 'CONFLICT', first: {}, second: {} } });
        await service.process(7n);
        expect(repository.markDead).toHaveBeenCalledWith(7n, expect.stringContaining('IDENTITY_CONFLICT'));
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('schedules another try after a database error', async () => {
        const { service, leads, repository, queue } = build();
        leads.importLead.mockRejectedValue(new Error('connection lost'));
        await service.process(7n);
        expect(repository.markFailed).toHaveBeenCalledWith(7n, expect.objectContaining({ error: 'connection lost' }));
        expect(queue.enqueue).toHaveBeenCalledWith(7n, 30_000);
    });

    it('gives up after the last try', async () => {
        const { service, leads, repository } = build({
            claim: { id: 7n, eventId: 'x', source: 'WORKR', type: 'workr.signup', attempts: MAX_ATTEMPTS, occurredAt: new Date(), payload: signup.payload },
        });
        leads.importLead.mockRejectedValue(new Error('still down'));
        await service.process(7n);
        expect(repository.markDead).toHaveBeenCalledWith(7n, expect.stringContaining('Gave up after 5 tries'));
    });

    it('fails, to be tried again, when there is no admin to own the lead', async () => {
        const { service, iam, repository } = build();
        iam.listActiveStaff.mockResolvedValue([]);
        await service.process(7n);
        expect(repository.markFailed).toHaveBeenCalledWith(7n, expect.objectContaining({ error: expect.stringContaining('no active admin') }));
    });

    it('does nothing when another worker already has the event', async () => {
        const { service, repository, leads } = build();
        repository.claim.mockResolvedValue(null);
        await service.process(7n);
        expect(leads.importLead).not.toHaveBeenCalled();
    });

    it('falls back to a list name of its own when someone made one with the same name by hand', async () => {
        const { service, leads } = build();
        leads.createList
            .mockRejectedValueOnce(new ConflictException({ code: 'LIST_NAME_TAKEN' }))
            .mockResolvedValueOnce({ id: 6n, publicId: 'l2', name: 'x' });
        await service.process(7n);
        expect(leads.createList).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'WorkR signups · 5 Nov 2026 (auto)' }));
    });
});

describe('IntakeService.sweep', () => {
    it('queues events nobody is handling and removes old personal details', async () => {
        const { service, repository, queue } = build();
        repository.findDue.mockResolvedValue([3n, 4n]);
        await expect(service.sweep()).resolves.toBe(2);
        expect(queue.enqueue).toHaveBeenCalledTimes(2);
        expect(repository.purgePayloads).toHaveBeenCalled();
    });
});
