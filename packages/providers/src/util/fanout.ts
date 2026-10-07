import { S1PilotError, type Capabilities, type DecideAnswer, type DecideRequest } from '@s1pilot/domain';

export type DecideCall = (req: DecideRequest) => Promise<Record<string, DecideAnswer>>;

/** Maximum parallel single-question calls. */
export const FANOUT_CONCURRENCY = 4;

/**
 * Answers all questions of `req` with `call`. When the model supports several questions per call
 * this is one call; otherwise each question is sent on its own (at most `concurrency` at once)
 * and the answers are merged into one record keyed by question id, in request order.
 */
export async function fanOut(
  req: DecideRequest,
  caps: Pick<Capabilities, 'multiQuestionPerCall'>,
  call: DecideCall,
  concurrency = FANOUT_CONCURRENCY,
): Promise<Record<string, DecideAnswer>> {
  const ids = Object.keys(req.questions);
  const answers: Record<string, DecideAnswer> = {};

  if (caps.multiQuestionPerCall || ids.length <= 1) {
    Object.assign(answers, await call(req));
  } else {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++] as string;
        const question = req.questions[id];
        if (!question) continue;
        const single = await call({ ...req, questions: { [id]: question } });
        const answer = single[id];
        if (answer) answers[id] = answer;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  }

  const missing = ids.filter((id) => !(id in answers));
  if (missing.length > 0) {
    throw new S1PilotError('MODEL_BAD_RESPONSE', `Model gave no answer for: ${missing.join(', ')}`, { missing });
  }
  return Object.fromEntries(ids.map((id) => [id, answers[id] as DecideAnswer]));
}
