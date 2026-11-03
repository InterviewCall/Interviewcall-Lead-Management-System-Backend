import { Injectable } from '@nestjs/common';
import { IamRepository } from './iam.repository.js';

@Injectable()
export class IamService {
    constructor(private readonly repository: IamRepository) {}
}
