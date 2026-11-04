import { Module } from '@nestjs/common';
import { IntakeModule } from './intake.module.js';
import { IntakeProcessor, IntakeSweeper } from './intake.processor.js';

/** The consuming side. Imported by the worker only, so the API process never runs an event itself. */
@Module({
    imports: [IntakeModule],
    providers: [IntakeProcessor, IntakeSweeper],
})
export class IntakeProcessorModule {}
