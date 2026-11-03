import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

@Injectable()
export class PasswordService {
    private decoyHash: Promise<string> | undefined;

    hash(plain: string): Promise<string> {
        return argon2.hash(plain, { type: argon2.argon2id });
    }

    async verify(hash: string, plain: string): Promise<boolean> {
        try {
            return await argon2.verify(hash, plain);
        } catch {
            // A malformed stored hash must read as a failed login, not a 500.
            return false;
        }
    }

    /**
     * Spends the same time as a real check. Login calls it for unknown or inactive accounts,
     * so response time does not reveal which emails exist.
     */
    async burn(plain: string): Promise<void> {
        this.decoyHash ??= this.hash('decoy-password-never-matches');
        await this.verify(await this.decoyHash, plain);
    }
}
