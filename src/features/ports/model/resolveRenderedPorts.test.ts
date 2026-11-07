import { describe, expect, it } from 'vitest';
import { resolveRenderedPorts } from './resolveRenderedPorts';
import type { SchemaPort } from './types';

function resolveSingle(schemaPort: SchemaPort, parameterValues: Record<string, string> = {}) {
  return resolveRenderedPorts({
    schemaPorts: [schemaPort],
    parameterValues,
  });
}

describe('resolveRenderedPorts', () => {
  it('renders explicit dynamic collections from catalog metadata and live parameter values', () => {
    const result = resolveSingle({
      name: 'banana',
      direction: 'input',
      cardinalityKind: 'dynamic',
      renderPortCount: 3,
      minPortCount: 1,
      maxPortCount: 32,
      sizeParameter: 'n_inputs',
      typeName: 'float',
    }, { n_inputs: '9' });

    expect(result.inputs).toHaveLength(9);
    expect(result.inputs.map((port) => port.portId)).toEqual([
      'banana#0',
      'banana#1',
      'banana#2',
      'banana#3',
      'banana#4',
      'banana#5',
      'banana#6',
      'banana#7',
      'banana#8',
    ]);
    expect(result.inputs.map((port) => port.handleId)).toEqual([
      'handle_banana_23_0',
      'handle_banana_23_1',
      'handle_banana_23_2',
      'handle_banana_23_3',
      'handle_banana_23_4',
      'handle_banana_23_5',
      'handle_banana_23_6',
      'handle_banana_23_7',
      'handle_banana_23_8',
    ]);
    expect(result.inputs.every((port) => port.connectable)).toBe(true);
  });

  it('keeps fixed ports fixed', () => {
    const result = resolveSingle({
      name: 'out',
      direction: 'output',
      cardinalityKind: 'fixed',
      typeName: 'float32',
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      key: 'output:out',
      direction: 'output',
      displayLabel: 'out',
      portId: 'out',
      sourceSchemaName: 'out',
      cardinalityKind: 'fixed',
      inference: 'authoritative',
      connectable: true,
      typeName: 'float32',
    });
  });

  it('uses handle_name_template when provided', () => {
    const result = resolveSingle({
      name: 'in',
      direction: 'input',
      cardinalityKind: 'dynamic',
      renderPortCount: 2,
      handleNameTemplate: 'in#${index}',
      sizeParameter: 'channels',
      typeName: 'float32',
    });

    expect(result.inputs.map((port) => port.portId)).toEqual(['in#0', 'in#1']);
    expect(result.inputs.map((port) => port.displayLabel)).toEqual(['in#0', 'in#1']);
    expect(result.inputs.map((port) => port.handleId)).toEqual(['handle_in_23_0', 'handle_in_23_1']);
    expect(result.inputs[0]).toMatchObject({
      key: 'input:in#0',
      sourceSchemaName: 'in',
      inference: 'authoritative',
    });
  });

  it('uses the catalog default when the declared size setting is omitted', () => {
    const result = resolveSingle(
      {
        name: 'banana',
        direction: 'input',
        cardinalityKind: 'dynamic',
        renderPortCount: 4,
        sizeParameter: 'n_inputs',
        minPortCount: 1,
        maxPortCount: 32,
      },
    );

    expect(result.inputs).toHaveLength(4);
    expect(result.inputs.map((port) => port.portId)).toEqual(['banana#0', 'banana#1', 'banana#2', 'banana#3']);
  });

  it('uses live sizeParameter values over renderPortCount when present', () => {
    const result = resolveSingle({
      name: 'banana',
      direction: 'input',
      cardinalityKind: 'dynamic',
      renderPortCount: 5,
      sizeParameter: 'n_inputs',
      minPortCount: 1,
      maxPortCount: 32,
      typeName: 'float32',
    }, { n_inputs: '7' });

    expect(result.inputs).toHaveLength(7);
    expect(result.inputs.map((port) => port.portId)).toEqual([
      'banana#0',
      'banana#1',
      'banana#2',
      'banana#3',
      'banana#4',
      'banana#5',
      'banana#6',
    ]);
  });

  it('does not guess count ownership from parameter names', () => {
    const result = resolveSingle(
      {
        name: 'inputs',
        direction: 'input',
        cardinalityKind: 'dynamic',
        typeName: 'float32',
      },
      { n_inputs: '2' },
    );

    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({ inference: 'collapsed', connectable: false });
  });
});


it('preserves zero and rejects invalid explicit counts without using a default', () => {
  const schema: SchemaPort = { name: 'bank', direction: 'input', cardinalityKind: 'dynamic',
    sizeParameter: 'Channels', renderPortCount: 3, minPortCount: 0, maxPortCount: 32 };
  expect(resolveSingle(schema, { Channels: '0' }).inputs).toEqual([]);
  for (const value of ['', 'oops', '-1', '2.5', '33']) {
    expect(resolveSingle(schema, { Channels: value }).inputs[0].connectable).toBe(false);
  }
  expect(resolveSingle(schema, { channels: '7' }).inputs).toHaveLength(3);
});

it('uses separate declared counts and preserves cardinality beyond the display cap', () => {
  const result = resolveRenderedPorts({ schemaPorts: [
    { name: 'a', direction: 'input', cardinalityKind: 'dynamic', sizeParameter: 'first' },
    { name: 'b', direction: 'input', cardinalityKind: 'dynamic', sizeParameter: 'second' },
  ], parameterValues: { first: '32', second: '2' } });
  const a = result.inputs.filter((p) => p.sourceSchemaName === 'a');
  expect(a.filter((p) => p.connectable)).toHaveLength(16);
  expect(a[a.length - 1]).toMatchObject({ semanticPortCount: 32, connectable: false });
  expect(a[a.length - 1]?.displayLabel).toContain('32 ports');
  expect(result.inputs.filter((p) => p.sourceSchemaName === 'b')).toHaveLength(2);
});


it('keeps existing connections above the display cap addressable', () => {
  const result = resolveRenderedPorts({ schemaPorts: [
    { name: 'bank', direction: 'input', cardinalityKind: 'dynamic', sizeParameter: 'count' },
  ], parameterValues: { count: '32' }, connectedPortIds: ['bank#25', 'bank#40'] });
  expect(result.inputs.find((p) => p.portId === 'bank#25')?.connectable).toBe(true);
  expect(result.inputs.find((p) => p.portId === 'bank#40')).toBeUndefined();
  expect(result.inputs[result.inputs.length - 1]?.semanticPortCount).toBe(32);
});

describe('reflected structural schema', () => {
  it('renders a fixed collection with indexed identities, including zero extent', () => {
    const schema: SchemaPort = {
      name: 'bank', direction: 'input', cardinalityKind: 'fixed',
      collectionKind: 'fixed', fixedExtent: 3, schemaVersion: 1,
      typeName: 'float64', isOptional: true, isSynchronous: false, portKind: 'stream',
    };
    const ports = resolveSingle(schema).inputs;
    expect(ports.map((p) => p.portId)).toEqual(['bank#0', 'bank#1', 'bank#2']);
    expect(ports.every((p) => p.typeName === 'float64' && p.isOptional && !p.isSynchronous)).toBe(true);
    expect(resolveSingle({ ...schema, fixedExtent: 0 }).inputs).toEqual([]);
    expect(resolveSingle({ ...schema, fixedExtent: 32 }).inputs).toHaveLength(32);
  });

  it('retains empty dynamic collection types without inventing handles', () => {
    const ports = resolveSingle({
      name: 'bank', direction: 'input', cardinalityKind: 'dynamic',
      collectionKind: 'dynamic', schemaVersion: 1,
      typeName: 'float64', isOptional: true, isSynchronous: false,
    }).inputs;
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ typeName: 'float64', inference: 'collapsed', connectable: false });
  });
});
