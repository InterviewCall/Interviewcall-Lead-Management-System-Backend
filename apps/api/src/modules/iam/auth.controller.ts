import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Inject,
    Ip,
    Post,
    Req,
    Res,
} from '@nestjs/common';
import {
    AllowPasswordChange,
    type AuthContext,
    CurrentUser,
    Public,
    RequireCsrf,
} from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import type { Request, Response } from 'express';
import {
    clearAuthCookies,
    REFRESH_COOKIE,
    setAuthCookies,
} from './auth.cookies.js';
import {
    type ChangePasswordBody,
    changePasswordSchema,
    type LoginBody,
    loginSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import type { SessionUser } from './iam.types.js';
import { SessionService } from './session.service.js';

/**
 * Login is limited per IP. An office shares one address, so the numbers leave room for a whole
 * team signing in at 9am; the account lock (10 wrong passwords) is what stops guessing.
 */
const LOGIN_LIMIT = { limit: 60, windowSeconds: 15 * 60 } as const;
/** Every open tab refreshes together; this only stops a runaway loop. */
const REFRESH_LIMIT = { limit: 120, windowSeconds: 60 } as const;
const LOGOUT_LIMIT = { limit: 60, windowSeconds: 60 } as const;
/** Per signed-in user. Each try is a password guess, so keep it tight. */
const PASSWORD_LIMIT = { limit: 10, windowSeconds: 15 * 60 } as const;

@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    /** Public. Checks the password, starts a session and sets the cookies. */
    @Public()
    @Post('login')
    @HttpCode(200)
    @RateLimit(LOGIN_LIMIT)
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

    /**
     * Public, because the access token has usually expired by now; the refresh cookie and the
     * CSRF header are what prove the caller. Replaces the refresh token and renews the access
     * token. A 401 means the sign-in is over: send the user to the login page.
     */
    @Public()
    @RequireCsrf()
    @Post('refresh')
    @HttpCode(200)
    @RateLimit(REFRESH_LIMIT)
    async refresh(
        @Req() request: Request,
        @Ip() ip: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ): Promise<{ user: SessionUser }> {
        const { user, tokens } = await this.sessions.refresh(
            refreshTokenOf(request),
            { ip, userAgent },
        );
        setAuthCookies(response, this.config, tokens);
        return { user };
    }

    /**
     * Ends this sign-in on the server and clears the cookies. Public so it works after the access
     * token has expired, and for an account that still has a temporary password. Always 204.
     */
    @Public()
    @RequireCsrf()
    @Post('logout')
    @HttpCode(204)
    @RateLimit(LOGOUT_LIMIT)
    async logout(
        @Req() request: Request,
        @Ip() ip: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ): Promise<void> {
        await this.sessions.logout(refreshTokenOf(request), { ip, userAgent });
        clearAuthCookies(response, this.config);
    }

    /**
     * Who is signed in. Open to an account with a temporary password: the web app calls this on
     * load to decide between the app and the "choose a new password" screen.
     */
    @AllowPasswordChange()
    @Get('me')
    async me(@CurrentUser() auth: AuthContext): Promise<{ user: SessionUser }> {
        return { user: await this.sessions.me(auth) };
    }

    /**
     * Change your own password. Open to an account that still has a temporary password: this is the
     * one thing it may do. Ends every other session and returns fresh cookies for this one.
     */
    @AllowPasswordChange()
    @Post('password')
    @HttpCode(200)
    @RateLimit(PASSWORD_LIMIT)
    async changePassword(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: changePasswordSchema }) body: ChangePasswordBody,
        @Ip() ip: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ): Promise<{ user: SessionUser }> {
        const { user, tokens } = await this.auth.changePassword(auth, body, {
            ip,
            userAgent,
        });
        setAuthCookies(response, this.config, tokens);
        return { user };
    }
}

function refreshTokenOf(request: Request): string | undefined {
    const value: unknown = request.cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
