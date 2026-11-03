import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { PrismaClient } from '@app/prisma';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

@Injectable()
export class ModelService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(ModelService.name);

    constructor() {
        const adapter = new PrismaMariaDb({
            host: requireEnv('DB_HOST'),
            port: Number(process.env.DB_PORT ?? 3306),
            user: requireEnv('DB_USER'),
            password: requireEnv('DB_PASSWORD'),
            database: requireEnv('DB_NAME'),
            connectionLimit: 5,
            connectTimeout: 5000,
            idleTimeout: 300,
        });

        super({ adapter });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
        this.logger.log('Prisma client initialised');
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }
}
