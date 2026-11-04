import { z } from 'zod';
import { vslBookedSchema, vslCompletedSchema, vslDetailsSchema, vslFormSchema } from './vsl-events.js';
import { workrSignupSchema } from './workr-signup.js';

/** The event types each source may send. A key for one source cannot post another's events. */
export const EVENT_TYPES = {
    WORKR: ['workr.signup'],
    VSL_FORM: ['vsl.details_submitted', 'vsl.form_submitted'],
    VSL_BOOKING: ['vsl.slot_booked', 'vsl.booking_completed'],
} as const;

export const eventEnvelopeSchema = z.object(
    {
        /** The sender's own id for this event. Sending it again is safe: it is stored once. */
        eventId: z.string('Send an eventId').trim().min(1, 'Send an eventId').max(64, 'eventId is too long'),
        type: z.string('Send the event type').trim().min(1).max(40),
        occurredAt: z.coerce.date('Send when it happened, as an ISO date'),
        payload: z.record(z.string(), z.unknown(), 'Send a payload object'),
    },
    'Send a JSON body with eventId, type, occurredAt and payload',
);
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
    'workr.signup': workrSignupSchema,
    'vsl.details_submitted': vslDetailsSchema,
    'vsl.form_submitted': vslFormSchema,
    'vsl.slot_booked': vslBookedSchema,
    'vsl.booking_completed': vslCompletedSchema,
};

export const eventIdSchema = z.coerce.bigint('Invalid event id');

export const listEventsQuerySchema = z.object({
    status: z.enum(['all', 'failed', 'dead', 'processed']).default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
