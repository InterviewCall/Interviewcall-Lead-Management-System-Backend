import {
    Body,
    Controller,
    Headers,
    HttpCode,
    Inject,
    Ip,
    Post,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { setAuthCookies } from './auth.cookies.js';
import { type LoginBody, loginSchema } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import type { SessionUser } from './iam.types.js';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    /** Public. Checks the password, starts a session and sets the cookies. */
    @Post('login')
    @HttpCode(200)
    async login(
        @Body({ schema: loginSchema }) body: LoginBody,
        @Ip() ip: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ): Promise<{ user: SessionUser }> {
        const { user, tokens } = await this.auth.login(body, { ip, userAgent });
        setAuthCookies(response, this.config, tokens);
        return { user };
    }
}
