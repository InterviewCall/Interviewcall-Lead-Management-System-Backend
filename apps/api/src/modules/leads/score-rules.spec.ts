import { awardsFor } from './score-rules.js';

describe('the lead score rules', () => {
    it('gives points once for each stage reached, by reason, and nothing for stages that carry none', () => {
        expect(awardsFor({ type: 'OPPORTUNITY_STAGE_CHANGED', data: { from: 'CALL_1', to: 'TEST' } })).toEqual([{ points: 10, reason: 'PIPELINE_TEST', ref: 'once' }]);
        expect(awardsFor({ type: 'OPPORTUNITY_STAGE_CHANGED', data: { from: 'CALL_1_PENDING', to: 'CALL_1' } })).toEqual([{ points: 10, reason: 'PIPELINE_CALL_1', ref: 'once' }]);
        expect(awardsFor({ type: 'OPPORTUNITY_STAGE_CHANGED', data: { from: 'CALL_1', to: 'CALL_1_PENDING' } })).toEqual([]);
        expect(awardsFor({ type: 'OPPORTUNITY_WON', data: { stage: 'PAYMENT_FINANCING' } })).toEqual([{ points: 40, reason: 'CLOSED_WON', ref: 'once' }]);
    });

    it('adds for Engaged and Prospect, takes away for Exhausted and Not interested, and ignores the rest', () => {
        const to = (stage: string) => awardsFor({ type: 'CONTACT_STAGE_CHANGED', data: { from: 'MARKETING_LEAD', to: stage } }).map((a) => a.points);
        expect(to('ENGAGED_LEAD')).toEqual([5]);
        expect(to('PROSPECT')).toEqual([15]);
        expect(to('EXHAUSTED_NOT_CONNECTED')).toEqual([-10]);
        expect(to('NOT_INTERESTED')).toEqual([-25]);
        expect(to('MARKETING_LEAD')).toEqual([]);
        expect(to('ENROLLED')).toEqual([]);
    });

    it('counts every connected call, and no other activity', () => {
        expect(awardsFor({ type: 'ACTIVITY_LOGGED', data: { activity: '7', kind: 'CALL' } }, true)).toEqual([{ points: 10, reason: 'CALL_CONNECTED', ref: 'activity:7' }]);
        expect(awardsFor({ type: 'ACTIVITY_LOGGED', data: { activity: '8', kind: 'CALL' } }, false)).toEqual([]);
        expect(awardsFor({ type: 'ACTIVITY_LOGGED', data: { activity: '9', kind: 'WHATSAPP' } }, true)).toEqual([]);
    });

    it('rewards the VSL steps: details once, a booking once, each attended call', () => {
        expect(awardsFor({ type: 'LEAD_CREATED', data: { via: 'VSL', step: 'DETAILS' } })).toEqual([{ points: 5, reason: 'VSL_DETAILS', ref: 'once' }]);
        expect(awardsFor({ type: 'LEAD_CREATED', data: { via: 'IMPORT' } })).toEqual([]);
        expect(awardsFor({ type: 'SLOT_BOOKED', data: { booking: 'b1' } })).toEqual([{ points: 20, reason: 'VSL_SLOT_BOOKED', ref: 'once' }]);
        expect(awardsFor({ type: 'BOOKING_COMPLETED', data: { booking: 'b1' } })).toEqual([{ points: 10, reason: 'VSL_CALL_ATTENDED', ref: 'booking:b1' }]);
        expect(awardsFor({ type: 'TASK_CREATED', data: null })).toEqual([]);
    });
});
