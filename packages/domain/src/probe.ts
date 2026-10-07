import { z } from 'zod';

import { CapabilitiesSchema } from './decision.js';
import { AdapterKindSchema } from './model-settings.js';

export const ProbeLatencySchema = z.object({
  /** Median of `samples`, in ms (0 when no samples were taken). */
  p50: z.number().min(0),
  samples: z.array(z.number().min(0)),
});

/** Outcome of probing a model endpoint (`s1pilot probe`, the "Test connection" button). */
export const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    /** Detected (or requested) adapter; absent when nothing could be detected. */
    adapter: AdapterKindSchema.optional(),
    model: z.string().optional(),
    capabilities: CapabilitiesSchema.optional(),
    latencyMs: ProbeLatencySchema,
    /** True when the endpoint is outside the user's machine/network (data leaves it). */
    isCloud: z.boolean(),
    warnings: z.array(z.string()),
    /** Human-readable reason when `ok` is false. */
    error: z.string().optional(),
  })
  .refine((r) => !r.ok || (r.adapter !== undefined && r.model !== undefined && r.capabilities !== undefined), {
    message: 'a successful probe must include adapter, model and capabilities',
  })
  .refine((r) => r.ok || r.error !== undefined, { message: 'a failed probe must include an error' });
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
