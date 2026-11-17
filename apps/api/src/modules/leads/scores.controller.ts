import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { SCORE_RULES } from './score-rules.js';
import { ScoringService } from './scoring.service.js';

/** How the lead score grows, and catching scores up from history. */
@Controller('scores')
export class ScoresController {
    constructor(private readonly scoring: ScoringService) {}

    /** The score rules, as people read them, for the lead page. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('rules')
    rules() {
        return { rules: SCORE_RULES };
    }

    /**
     * Goes through every lead's history and adds any points that are missing (leads from before scoring existed).
     * Nothing is counted twice, so it is safe to run again. Admins only.
     */
    @Roles('ADMIN')
    @Post('recalculate')
    @HttpCode(200)
    @RateLimit({ limit: 3, windowSeconds: 600 })
    recalculate() {
        return this.scoring.recalculate();
    }
}
