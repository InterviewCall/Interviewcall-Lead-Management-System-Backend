import 'dotenv/config';

import argon2 from 'argon2';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { type Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
    Role,
    SourceGroup,
    SourceSystem,
} from '../src/generated/prisma/enums.js';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function createClient(): PrismaClient {
    const adapter = new PrismaMariaDb({
        host: requireEnv('DB_HOST'),
        port: Number(process.env.DB_PORT ?? 3306),
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        database: requireEnv('DB_NAME'),
        connectionLimit: 2,
        connectTimeout: 5000,
    });

    return new PrismaClient({ adapter });
}

// Staff phone numbers are stored in international form, e.g. +919876543210. Spaces, dashes and
// brackets are allowed in the environment value and dropped here.
function parseSeedPhone(value: string): string {
    const phone = value.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        throw new Error('SEED_ADMIN_PHONE must start with the country code, e.g. +919876543210');
    }
    return phone;
}

async function seedAdmin(prisma: PrismaClient): Promise<void> {
    const email = requireEnv('SEED_ADMIN_EMAIL').trim().toLowerCase();
    const name = requireEnv('SEED_ADMIN_NAME').trim();
    const password = requireEnv('SEED_ADMIN_PASSWORD');
    const configuredPhone = process.env.SEED_ADMIN_PHONE?.trim();
    const phone = configuredPhone ? parseSeedPhone(configuredPhone) : null;

    if (password.length < 10) {
        throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');
    }

    const existing = await prisma.staffUser.findUnique({ where: { email } });

    if (existing) {
        // The account is already there. Its profile is refreshed from the environment, but
        // passwordHash is deliberately left alone so that re-running the seed can never
        // silently reset a password that was rotated since.
        // The phone is filled in only when the account has none, so a number the admin has since
        // changed is never overwritten, and never when another account already holds it.
        const holder = phone ? await prisma.staffUser.findUnique({ where: { phone }, select: { id: true } }) : null;
        const fillPhone = phone !== null && existing.phone === null && holder === null;
        await prisma.staffUser.update({
            where: { email },
            data: { name, role: Role.ADMIN, isActive: true, ...(fillPhone ? { phone } : {}) },
        });
        console.log(`Admin already present, profile refreshed (password untouched): ${email}`);
        return;
    }

    // Every account needs a phone number, the first admin included.
    if (phone === null) {
        throw new Error('Missing required environment variable: SEED_ADMIN_PHONE (with the country code, e.g. +919876543210)');
    }

    await prisma.staffUser.create({
        data: {
            name,
            email,
            phone,
            passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
            role: Role.ADMIN,
            // The password is the one you chose in SEED_ADMIN_PASSWORD, not a temporary one.
            mustChangePassword: false,
        },
    });
    console.log(`Admin created: ${email}`);
}

// Starting sources. The match rules are defaults: an admin can edit them in the CRM, and the
// seed never overwrites a source that already exists.
async function seedLeadSources(prisma: PrismaClient): Promise<void> {
    const sources = [
        { name: 'WorkR', group: SourceGroup.WORKR, matchRule: { system: 'WORKR' }, matchOrder: 10 },
        {
            name: 'Meta ads',
            group: SourceGroup.META,
            matchRule: { system: 'VSL_FORM', utmSource: ['facebook', 'fb', 'instagram', 'ig', 'meta'] },
            matchOrder: 20,
        },
        {
            name: 'VSL job-switch',
            group: SourceGroup.VSL,
            matchRule: { system: 'VSL_FORM', formSlug: 'job-switch' },
            matchOrder: 30,
        },
        { name: 'Organic', group: SourceGroup.ORGANIC, matchRule: undefined, matchOrder: 900 },
        // Tagged by the import job, so it has no match rule.
        { name: 'CSV import', group: SourceGroup.IMPORT, matchRule: undefined, matchOrder: 1000 },
        // For leads added by hand. An admin can add more on the Lead sources screen.
        { name: 'Referral', group: SourceGroup.REFERRAL, matchRule: undefined, matchOrder: 800 },
        { name: 'Walk-in', group: SourceGroup.OTHER, matchRule: undefined, matchOrder: 800 },
        { name: 'Inbound call', group: SourceGroup.OTHER, matchRule: undefined, matchOrder: 800 },
    ];

    for (const source of sources) {
        await prisma.leadSource.upsert({
            where: { name: source.name },
            update: {},
            create: source,
        });
    }
    console.log(`Lead sources ensured: ${sources.length}`);
}

async function seedLostReasons(prisma: PrismaClient): Promise<void> {
    const reasons = [
        'Wrong Number',
        'Out of TG',
        'Time Constraint',
        'Self-Preparation',
        'Financial Constraint',
        'Disqualified',
        'Not Applicable',
        'Invalid',
        'Fresher',
    ];

    for (const [index, name] of reasons.entries()) {
        await prisma.lostReason.upsert({
            where: { name },
            update: {},
            create: { name, sortOrder: index },
        });
    }
    console.log(`Lost reasons ensured: ${reasons.length}`);
}

/**
 * The outcomes a call can end with. A row, so the manager can add or change one without a deploy.
 * `effect` says what logging it does (see schema/engagement.prisma); `requiresFollowup` makes the next step compulsory.
 * Existing rows are left as a manager changed them.
 */
async function seedOutcomes(prisma: PrismaClient): Promise<void> {
    const outcomes: Array<{ name: string; effect: Prisma.InputJsonObject; requiresFollowup: boolean }> = [
        { name: 'Connected', effect: { connected: true, lifecycle: 'ENGAGED_LEAD' }, requiresFollowup: true },
        { name: 'Interested', effect: { connected: true, lifecycle: 'PROSPECT' }, requiresFollowup: true },
        { name: 'Call back later', effect: { connected: true, conversation: false }, requiresFollowup: true },
        { name: 'No answer', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
        { name: 'Busy', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
        { name: 'Switched off', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
        { name: 'Wrong number', effect: { connected: false, closeAs: 'LOST', lostReason: 'Wrong Number' }, requiresFollowup: false },
        { name: 'Not interested', effect: { connected: true, lifecycle: 'NOT_INTERESTED' }, requiresFollowup: false },
    ];

    for (const [index, outcome] of outcomes.entries()) {
        await prisma.outcome.upsert({
            where: { name: outcome.name },
            update: {},
            create: { ...outcome, sortOrder: index },
        });
    }
    // Rows written before `conversation` existed: "Call back later" means they picked up but did not talk.
    const callBack = await prisma.outcome.findUnique({ where: { name: 'Call back later' } });
    const current = callBack?.effect;
    if (callBack && current && typeof current === 'object' && !Array.isArray(current) && !('conversation' in current)) {
        await prisma.outcome.update({ where: { id: callBack.id }, data: { effect: { ...current, conversation: false } } });
    }
    console.log(`Call outcomes ensured: ${outcomes.length}`);
}

async function seedCursors(prisma: PrismaClient): Promise<void> {
    await prisma.distributionCursor.upsert({
        where: { scope: 'default' },
        update: {},
        create: { scope: 'default' },
    });

    for (const source of [
        SourceSystem.WORKR,
        SourceSystem.VSL_FORM,
        SourceSystem.VSL_BOOKING,
    ]) {
        await prisma.reconciliationCursor.upsert({
            where: { source },
            update: {},
            create: { source },
        });
    }
    console.log('Distribution and reconciliation cursors ensured');
}

async function main(): Promise<void> {
    const prisma = createClient();

    try {
        await seedAdmin(prisma);
        await seedLeadSources(prisma);
        await seedLostReasons(prisma);
        await seedOutcomes(prisma);
        await seedCursors(prisma);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
});
