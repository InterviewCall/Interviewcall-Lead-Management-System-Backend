import 'dotenv/config';

import argon2 from 'argon2';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { PrismaClient } from '../src/generated/prisma/client.js';
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

async function seedAdmin(prisma: PrismaClient): Promise<void> {
    const email = requireEnv('SEED_ADMIN_EMAIL').trim().toLowerCase();
    const name = requireEnv('SEED_ADMIN_NAME').trim();
    const password = requireEnv('SEED_ADMIN_PASSWORD');

    if (password.length < 10) {
        throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');
    }

    const existing = await prisma.staffUser.findUnique({ where: { email } });

    if (existing) {
        // The account is already there. Its profile is refreshed from the environment, but
        // passwordHash is deliberately left alone so that re-running the seed can never
        // silently reset a password that was rotated since.
        await prisma.staffUser.update({
            where: { email },
            data: { name, role: Role.ADMIN, isActive: true },
        });
        console.log(`Admin already present, profile refreshed (password untouched): ${email}`);
        return;
    }

    await prisma.staffUser.create({
        data: {
            name,
            email,
            passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
            role: Role.ADMIN,
            mustChangePassword: true,
        },
    });
    console.log(`Admin created (must change password on first login): ${email}`);
}

// Starting sources. The match rules are defaults: an admin can edit them in the CRM, and the
// seed never overwrites a source that already exists.
async function seedLeadSources(prisma: PrismaClient): Promise<void> {
    const sources = [
        { name: 'WorkR', group: SourceGroup.WORKR, matchRule: { system: 'WORKR' }, matchOrder: 10 },
        {
            name: 'Meta ads',
            group: SourceGroup.META,
            matchRule: { system: 'VSL_FORM', utmSource: 'facebook' },
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
        await seedCursors(prisma);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
});
