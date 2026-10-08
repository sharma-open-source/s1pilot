import { cases } from './cases.js';
import { defects } from './defects.js';
import { environments } from './environments.js';
import { healProposals } from './heal-proposals.js';
import { learnedScripts } from './learned-scripts.js';
import { plans } from './plans.js';
import { projects } from './projects.js';
import { results } from './results.js';
import { reviews } from './reviews.js';
import { runs } from './runs.js';
import { settings } from './settings.js';
import { sharedSteps } from './shared-steps.js';
import { suites } from './suites.js';

/** All repositories. Every function takes the `Db` as its first argument and returns domain types. */
export const repos = {
  projects,
  environments,
  suites,
  cases,
  sharedSteps,
  learnedScripts,
  plans,
  runs,
  results,
  defects,
  reviews,
  healProposals,
  settings,
};

export type { CaseFilters, NewTestCase, CasesRepo } from './cases.js';
export type { DefectsRepo } from './defects.js';
export type { EnvironmentsRepo } from './environments.js';
export { createDbLearnedScriptStore, type LearnedScriptKey } from './learned-scripts.js';
export type { HealApplyScope, HealProposalFilter, HealProposalsRepo } from './heal-proposals.js';
export type { LearnedScriptsRepo } from './learned-scripts.js';
export type { PlansRepo } from './plans.js';
export type { ProjectsRepo } from './projects.js';
export type { ResultsRepo } from './results.js';
export type { ReviewsRepo } from './reviews.js';
export type { RunsRepo } from './runs.js';
export type { SettingsRepo } from './settings.js';
export type { SharedStepsRepo } from './shared-steps.js';
export type { SuitesRepo } from './suites.js';
