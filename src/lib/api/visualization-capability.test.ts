import { afterEach, expect, it, vi } from 'vitest';
import { getBlockDetails } from './block-details';
import { normalizeVisualizationCapability } from './visualization-capability';
import { lookupStudioKnownBlockBinding } from '../../features/graph-editor/runtime/known-block-bindings';
import { buildStudioAuthoringBindingView } from '../../features/graph-editor/runtime/studio-managed-runtime-authoring';
import { deriveDefaultStudioPanelsFromNodes } from '../../features/workspace/model/panel-derivation';
import { derivePlotPanelSpec } from '../../features/application/plotting/model/panel-spec';
import { graphDocumentFromEditor } from '../../features/graph-document/model/fromEditor';
import { toGrctrlContentSubmission } from '../../features/runtime-submission/model/toGrctrlPayload';

afterEach(() => vi.unstubAllGlobals());
const capability = {
  version: 1, family: 'series', payload_format: 'series-window-json-v1', routing: 'session',
  supported_transports: ['http_poll'],
  parameters: { transport: 'transport', endpoint: 'endpoint', seriesCount: 'streams' },
};

it('supports an unknown block ID through API metadata, authoring, panels, and submission', async () => {
  const id = 'custom::Display<float32>';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id, name: 'Custom display', capabilities: { 'studio:visualization': capability },
    parameters: ['transport', 'endpoint', 'streams'].map((name) => ({ name })),
  }))));
  const details = await getBlockDetails(id);
  const byType = new Map([[id, details]]);
  const node = { instanceId: 'display', blockTypeId: id, displayName: 'Display',
    position: { x: 0, y: 0 }, parameters: {
      transport: { value: 'http_poll', bindingKind: 'literal' as const },
      streams: { value: '2', bindingKind: 'literal' as const },
    } };
  const values = { transport: 'http_poll', streams: '2' };
  expect(buildStudioAuthoringBindingView(id, values, details.studioBinding)).toMatchObject({ status: 'configured', channels: 2 });
  expect(buildStudioAuthoringBindingView(id, { ...values, transport: 'websocket' }, details.studioBinding).status).toBe('invalid');
  const panels = deriveDefaultStudioPanelsFromNodes([node], byType);
  expect(panels[0].kind).toBe('series');
  const plot = derivePlotPanelSpec({ panel: panels[0], nodeBlockTypeId: id,
    nodeParameters: values, reflectedBinding: details.studioBinding });
  expect(plot?.view.seriesLabels).toEqual(['ch0', 'ch1']);
  const document = graphDocumentFromEditor({ metadata: { name: 'Capability' }, nodes: [node], edges: [] });
  expect(toGrctrlContentSubmission(document, { blockDetailsByType: byType }).content).toContain('series-window-json-v1');
});

it('rejects unsupported contracts and does not fall back to a known ID', () => {
  const id = 'gr::studio::StudioSeriesSink<float32>';
  const names = ['transport', 'endpoint', 'streams'];
  expect(normalizeVisualizationCapability(id, undefined, names)).toBeUndefined();
  const unsupported = normalizeVisualizationCapability(id, { ...capability, version: 2 }, names);
  expect(unsupported).toBeNull();
  expect(lookupStudioKnownBlockBinding(id, unsupported)).toBeNull();
  expect(normalizeVisualizationCapability(id, { ...capability, payload_format: 'unknown-v5' }, names)).toBeNull();
  expect(normalizeVisualizationCapability(id, capability, ['transport'])).toBeNull();
});
