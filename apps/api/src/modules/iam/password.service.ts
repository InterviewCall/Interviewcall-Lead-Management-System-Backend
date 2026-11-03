import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

// No 0/O, 1/l/I: a temporary password is read off an email and typed in.
const TEMPORARY_ALPHABET =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

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

    /** A random one-time password for a new or reset account (14 characters, about 80 bits). */
    generateTemporary(length = 14): string {
        let password = '';
        for (let i = 0; i < length; i++) {
            password +=
                TEMPORARY_ALPHABET[randomInt(TEMPORARY_ALPHABET.length)];
        }
        return password;
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
