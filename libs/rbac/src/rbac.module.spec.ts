import { Test } from '@nestjs/testing';
import { AccessTokenVerifier } from './access-token.verifier.js';
import { RbacModule } from './rbac.module.js';

describe('RbacModule', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('builds a verifier from ACCESS_TOKEN_SECRET', async () => {
        vi.stubEnv(
            'ACCESS_TOKEN_SECRET',
            'unit-test-secret-unit-test-secret-000',
        );

        const moduleRef = await Test.createTestingModule({
            imports: [RbacModule],
        }).compile();

        expect(moduleRef.get(AccessTokenVerifier)).toBeInstanceOf(
            AccessTokenVerifier,
        );
    });

    it('refuses to start without a secret', async () => {
        vi.stubEnv('ACCESS_TOKEN_SECRET', '');

        await expect(
            Test.createTestingModule({ imports: [RbacModule] }).compile(),
        ).rejects.toThrow(/ACCESS_TOKEN_SECRET/);
    });
});
