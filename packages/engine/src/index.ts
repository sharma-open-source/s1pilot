import { DOMAIN_PACKAGE } from '@s1pilot/domain';

/** Package name; placeholder export until the engine lands (S-012+). */
export const ENGINE_PACKAGE = '@s1pilot/engine';

/** Domain package this engine builds on; proves workspace linking works. */
export const ENGINE_DOMAIN: typeof DOMAIN_PACKAGE = DOMAIN_PACKAGE;
