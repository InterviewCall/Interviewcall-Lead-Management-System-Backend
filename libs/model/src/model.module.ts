import { Global, Module } from '@nestjs/common';
import { ModelService } from './model.service.js';

@Global()
@Module({
    providers: [ModelService],
    exports: [ModelService],
})
export class ModelModule {}
