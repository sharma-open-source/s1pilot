import { VerdictSchema } from '@s1pilot/domain';

export * from './decide/index.js';
export * from './executor/index.js';
export * from './narrow/index.js';
export * from './observer/index.js';

/** Package name; placeholder export until the engine lands (S-012+). */
export const ENGINE_PACKAGE = '@s1pilot/engine';

/** Verdicts the engine can produce; proves workspace linking to `@s1pilot/domain` works. */
export const ENGINE_VERDICTS = VerdictSchema.options;
