import { Module } from '@nestjs/common';
import { AgentAuthController, AgentClientsController } from './agent-auth.controller.js';
import { AgentAuthService } from './agent-auth.service.js';

/** Delegated sign-in for the staff AI assistant. Token checks live in AuthGuard. */
@Module({
  controllers: [AgentAuthController, AgentClientsController],
  providers: [AgentAuthService],
})
export class AgentAuthModule {}
