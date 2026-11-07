import { z } from 'zod';
import type { StudioKnownBlockBinding } from '../../features/graph-editor/runtime/known-block-bindings';

const capabilitySchema = z.object({
  version: z.literal(1),
  family: z.enum(['series', 'series2d', 'histogram', 'waterfall', 'audio', 'image', 'scalar', 'status']),
  payload_format: z.string(),
  routing: z.literal('session'),
  semantic_kind: z.enum(['time_series', 'power_spectrum', 'waterfall', 'dataset', 'xy']).optional(),
  supported_transports: z.array(z.enum(['http_snapshot', 'http_poll', 'websocket'])).nonempty(),
  parameters: z.object({
    // The current managed stream protocol requires these conventional names.
    transport: z.literal('transport'), endpoint: z.literal('endpoint'),
    updateMs: z.string().optional(), pollMs: z.string().optional(), sampleRate: z.string().optional(),
    channels: z.string().optional(), seriesCount: z.string().optional(), topic: z.string().optional(),
    bufferMs: z.string().optional(),
  }),
});

const payloads: Record<string, readonly string[]> = {
  series: ['series-window-json-v1'], series2d: ['series2d-xy-json-v1', 'dataset-xy-json-v1'],
  histogram: ['dataset-xy-json-v1'], waterfall: ['waterfall-spectrum-json-v1'],
  audio: ['audio-float32-binary-v1'], image: ['image-frame-json-v1'],
  scalar: ['scalar-status-json-v1'], status: ['scalar-status-json-v1'],
};

/** Undefined means absent; null means an advertised capability is unsupported, with no ID fallback. */
export function normalizeVisualizationCapability(
  id: string, raw: unknown, parameterNames: readonly string[],
): StudioKnownBlockBinding | null | undefined {
  if (raw === undefined) return undefined;
  const parsed = capabilitySchema.safeParse(raw);
  if (!parsed.success) return null;
  const capability = parsed.data;
  if (!payloads[capability.family].includes(capability.payload_format)) return null;
  if (Object.values(capability.parameters).some((name) => name !== undefined && !parameterNames.includes(name))) return null;
  return {
    blockTypeId: id, family: capability.family, payloadFormat: capability.payload_format,
    supportedTransports: capability.supported_transports, parameters: capability.parameters,
    routing: capability.routing, semanticKind: capability.semantic_kind,
  };
}
