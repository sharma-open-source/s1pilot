import type { Calibrator, DecideAnswer, DecideRequest, DecisionModel } from '@s1pilot/domain';

import { calibrateAnswer } from './normalize.js';

/**
 * Wraps a System 1 model so every answer is calibrated with the injected {@link Calibrator} (S-058): the
 * temperature of `(modelName, question type, option count bucket)` is applied and the raw output is kept on
 * `answer.raw`. Questions without a fitted bucket pass through unchanged (T = 1).
 */
export function calibratedDecisionModel(model: DecisionModel, modelName: string, calibrator: Calibrator): DecisionModel {
  return {
    capabilities: model.capabilities,
    async decide(req: DecideRequest): Promise<Record<string, DecideAnswer>> {
      const answers = await model.decide(req);
      const out: Record<string, DecideAnswer> = {};
      for (const [id, answer] of Object.entries(answers)) {
        const question = req.questions[id];
        out[id] = question
          ? calibrateAnswer(question, answer, calibrator.temperature(modelName, question.type, Object.keys(answer.probabilities).length))
          : answer;
      }
      return out;
    },
  };
}
