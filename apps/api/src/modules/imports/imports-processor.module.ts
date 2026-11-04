import { Module } from '@nestjs/common';
import { ImportsModule } from './imports.module.js';
import { ImportsProcessor } from './imports.processor.js';

/** The consuming side. Imported by the worker only, so the API process never runs an import itself. */
@Module({
    imports: [ImportsModule],
    providers: [ImportsProcessor],
})
export class ImportsProcessorModule {}
