import { afterEach, expect, it, vi } from 'vitest';
import { getBlockDetails } from './block-details';

afterEach(() => vi.unstubAllGlobals());

it('preserves structural port schema when normalizing catalog JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'schema', name: 'Schema',
    parameters: [{ name: 'gain', label: 'Gain', unit: 'V', visible: false, minimum: 0, maximum: 10 }],
    inputs: [{ name: 'bank', type: 'float64', cardinality_kind: 'fixed',
      collection_kind: 'fixed', fixed_extent: 0, schema_version: 1,
      port_kind: 'stream', is_optional: true, is_synchronous: false }],
  }))));
  const details = await getBlockDetails('schema');
  expect(details.parameters[0]).toMatchObject({ label: 'Gain', unit: 'V', visible: false, minimum: 0, maximum: 10 });
  expect(details.inputPorts[0]).toMatchObject({
    name: 'bank', valueType: 'float64', collectionKind: 'fixed', fixedExtent: 0,
    schemaVersion: 1, portKind: 'stream', isOptional: true, isSynchronous: false,
  });
});
