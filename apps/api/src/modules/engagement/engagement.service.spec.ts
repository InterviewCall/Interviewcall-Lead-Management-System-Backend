import { Test } from '@nestjs/testing';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineService } from '@modules/timeline';
import { EngagementRepository } from './engagement.repository.js';
import { outcomeEffectSchema, parseEffect, createTaskSchema, logActivitySchema, taskIdSchema } from './engagement.schemas.js';
import { AdminService } from '@modules/admin';
import { EngagementService } from './engagement.service.js';

describe('EngagementService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                EngagementService,
                { provide: EngagementRepository, useValue: {} },
                { provide: LeadsService, useValue: {} },
                { provide: PipelineService, useValue: {} },
                { provide: TimelineService, useValue: {} },
                { provide: IamService, useValue: {} },
                { provide: AdminService, useValue: {} },
            ],
        }).compile();

        expect(moduleRef.get(EngagementService)).toBeDefined();
    });
});

describe('what an outcome does', () => {
    it('reads the known keys', () => {
        expect(parseEffect({ connected: false, countsAsAttempt: true })).toEqual({ connected: false, countsAsAttempt: true });
        expect(parseEffect({ lifecycle: 'PROSPECT', connected: true })).toEqual({ lifecycle: 'PROSPECT', connected: true });
    });

    it('ignores keys it does not know and does nothing for a row that does not fit', () => {
        expect(parseEffect({ connected: true, somethingNew: 1 })).toEqual({ connected: true });
        expect(parseEffect({ lifecycle: 'ENROLLED' })).toEqual({});
        expect(parseEffect(null)).toEqual({});
        expect(parseEffect('connected')).toEqual({});
        expect(outcomeEffectSchema.safeParse({ lostReason: '' }).success).toBe(false);
    });
});

describe('the log-an-activity body', () => {
    it('fills the optional parts with null', () => {
        const parsed = logActivitySchema.parse({ kind: 'NOTE', notes: '  hello  ' });
        expect(parsed).toEqual({ kind: 'NOTE', outcomeId: null, notes: 'hello', stage: null, stageDate: null, temperature: null, nextStep: null });
    });

    it('turns the due time into a date and refuses a malformed one', () => {
        const ok = logActivitySchema.parse({ kind: 'CALL', outcomeId: 3, nextStep: { title: ' Call ', dueAt: '2026-11-12T10:00:00.000Z' } });
        expect(ok.nextStep?.title).toBe('Call');
        expect(ok.nextStep?.dueAt).toEqual(new Date('2026-11-12T10:00:00.000Z'));
        expect(logActivitySchema.safeParse({ kind: 'CALL', outcomeId: 3, nextStep: { title: 'x', dueAt: 'tomorrow' } }).success).toBe(false);
        expect(logActivitySchema.safeParse({ kind: 'CALL', surprise: true }).success).toBe(false);
    });

    it('limits what can be asked of a task', () => {
        expect(createTaskSchema.safeParse({ title: 'x'.repeat(151), dueAt: '2026-11-12T10:00:00Z' }).success).toBe(false);
        expect(taskIdSchema.safeParse('12').success).toBe(true);
        expect(taskIdSchema.safeParse('0').success).toBe(false);
        expect(taskIdSchema.safeParse('1; drop table').success).toBe(false);
    });
});
