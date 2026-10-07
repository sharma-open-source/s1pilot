export type {
  Capabilities,
  DecideAnswer,
  DecideRequest,
  DecisionModel,
  ImagePart,
  Question,
} from '@s1pilot/domain';

/** One chat message. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  /** Ask the model to answer with a JSON object. */
  json?: boolean;
  maxTokens?: number;
}

export interface PickOptionRequest {
  /** Untrusted page/test context; adapters must present it as data, not instructions. */
  context: string;
  question: string;
  /** Option id → description. */
  options: Record<string, string>;
}

/** System 2: a chat LLM used for text, second opinions and test generation. */
export interface ChatModel {
  chat(req: ChatRequest): Promise<{ text: string; latencyMs: number }>;
  /** Constrained to one of `options`; adapters must reject any other id. */
  pickOption(req: PickOptionRequest): Promise<{ choice: string; rationale?: string }>;
}
