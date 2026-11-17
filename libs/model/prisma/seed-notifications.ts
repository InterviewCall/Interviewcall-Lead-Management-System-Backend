/**
 * Dev-only: fills one staff member's notification bell with sample alerts so the feature can be
 * tried by hand. It never touches a production database.
 *
 *   npm run seed:notifications                      first active BDA
 *   npm run seed:notifications -- someone@mail.com  that staff member
 *
 * What it creates for that person (everything is re-created on each run, so it is safe to repeat):
 *   - 3 unread alerts + 1 already-read one, written straight into the bell
 *   - a booked call starting in ~10 minutes  -> the bell raises "A booked call starts at ..." itself
 *   - a follow-up that fell due ~2 hours ago -> the bell raises "A follow-up is overdue" itself
 *   - for a manager or admin: a booked call that has no owner, plus the alert for it
 * Both timed alerts appear after the bell next polls (every 60 seconds), or on a page refresh.
 */
import 'dotenv/config';

import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { PrismaClient } from '../src/generated/prisma/client.js';

const TAG = 'dummy-notif-';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

const minutes = (n: number): Date => new Date(Date.now() + n * 60_000);

async function main(): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to add sample data when NODE_ENV=production');

    const prisma = new PrismaClient({
        adapter: new PrismaMariaDb({
            host: requireEnv('DB_HOST'),
            port: Number(process.env.DB_PORT ?? 3306),
            user: requireEnv('DB_USER'),
            password: requireEnv('DB_PASSWORD'),
            database: requireEnv('DB_NAME'),
            connectionLimit: 2,
            connectTimeout: 5000,
        }),
    });

    try {
        const email = process.argv[2]?.trim().toLowerCase();
        const user = email
            ? await prisma.staffUser.findUnique({ where: { email } })
            : await prisma.staffUser.findFirst({ where: { role: 'BDA', isActive: true }, orderBy: { id: 'asc' } });
        if (!user) throw new Error(email ? `No staff member with email ${email}` : 'No active BDA found, pass an email');

        // Leads to hang the alerts on: the person's own leads first, then any lead, so it works on any data.
        const wanted = 4;
        const own = await prisma.lead.findMany({ where: { ownerId: user.id }, orderBy: { id: 'asc' }, take: wanted, select: { id: true } });
        const others =
            own.length >= wanted
                ? []
                : await prisma.lead.findMany({ where: { id: { notIn: own.map((l) => l.id) } }, orderBy: { id: 'asc' }, take: wanted - own.length, select: { id: true } });
        const leads = [...own, ...others];
        if (leads.length < wanted) throw new Error(`Need at least ${wanted} leads in the database, found ${leads.length}`);
        const [a, b, c, d] = leads.map((l) => l.id) as [bigint, bigint, bigint, bigint];

        // Clean slate for this person, so repeated runs do not pile up.
        await prisma.notification.deleteMany({ where: { userId: user.id } });
        await prisma.task.deleteMany({ where: { OR: [{ bookingRef: { startsWith: TAG } }, { payload: { path: '$.seed', equals: TAG } }] } });

        await prisma.notification.createMany({
            data: [
                { userId: user.id, type: 'NEW_ASSIGNMENT', message: '12 new leads were assigned to you', createdAt: minutes(-180) },
                { userId: user.id, type: 'LEAD_REENGAGED', leadId: a, message: 'A lead you are nurturing is back on the VSL', createdAt: minutes(-40) },
                { userId: user.id, type: 'LEAD_REENGAGED', leadId: b, message: 'A lead you are working booked a call on the VSL', createdAt: minutes(-5) },
                // one that is already read, to see the read look
                { userId: user.id, type: 'DUPLICATE_REVIEW', leadId: d, message: 'Two leads look like the same person', createdAt: minutes(-60 * 26), readAt: minutes(-60 * 25) },
            ],
        });

        // The bell raises these two on its own when it polls.
        await prisma.task.create({
            data: { leadId: c, assigneeId: user.id, type: 'SCHEDULED_CALL', title: 'Counselling call', dueAt: minutes(10), bookingRef: `${TAG}soon-${user.id}` },
        });
        await prisma.task.create({
            data: { leadId: a, assigneeId: user.id, type: 'FOLLOW_UP', title: 'Call back about the test slot', dueAt: minutes(-120), payload: { seed: TAG } },
        });

        if (user.role === 'SALES_MANAGER' || user.role === 'ADMIN') {
            const unowned = await prisma.task.create({
                data: { leadId: d, assigneeId: null, type: 'SCHEDULED_CALL', title: 'Counselling call', dueAt: minutes(60 * 24), bookingRef: `${TAG}unowned-${user.id}` },
            });
            await prisma.notification.create({
                data: { userId: user.id, type: 'BOOKED_SLOT_UNASSIGNED', leadId: d, taskId: unowned.id, message: 'A booked call has no owner yet', createdAt: minutes(-2) },
            });
        }

        console.log(`Sample alerts ready for ${user.name} <${user.email}> (${user.role}).`);
        console.log('Log in as that person: the bell shows the unread ones now; "call starts at" and "follow-up is overdue" appear within a minute.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
