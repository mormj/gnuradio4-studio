import type {
  RenderedPort,
  ResolveRenderedPortsInput,
  ResolveRenderedPortsResult,
  SchemaPort,
} from './types';

export const DEFAULT_DYNAMIC_PORT_UI_CAP = 16;

function tryParseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function normalizePortCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Number.isSafeInteger(value) ? value : null;
}

function toReactFlowHandleId(portId: string): string {
  const safeToken = Array.from(portId)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)?.toString(16)}_`))
    .join('');

  return `handle_${safeToken}`;
}

function renderHandleName(schemaPort: SchemaPort, index: number): string {
  const template = schemaPort.handleNameTemplate;
  if (template) {
    return template.replace(/\$\{index\}/g, String(index));
  }

  return `${schemaPort.name}[${index}]`;
}

function renderHandlePortId(schemaPort: SchemaPort, index: number): string {
  const template = schemaPort.handleNameTemplate;
  if (template) {
    return template.replace(/\$\{index\}/g, String(index));
  }

  return `${schemaPort.name}#${index}`;
}

function explicitDynamicCount(schemaPort: SchemaPort, parameterValues: Record<string, string>): number | null {
  const parameter = schemaPort.sizeParameter;
  if (!parameter) return null;
  const raw = parameterValues[parameter];
  const count = raw === undefined
    ? normalizePortCount(schemaPort.renderPortCount)
    : tryParseNonNegativeInteger(raw);
  if (count === null || !Number.isSafeInteger(count)) return null;
  if (schemaPort.minPortCount !== undefined && count < schemaPort.minPortCount) return null;
  if (schemaPort.maxPortCount !== undefined && schemaPort.maxPortCount >= 0 && count > schemaPort.maxPortCount) return null;
  return count;
}

function fixedRenderedPort(schemaPort: SchemaPort): RenderedPort {
  const portId = schemaPort.name;
  return {
    key: `${schemaPort.direction}:${portId}`,
    direction: schemaPort.direction,
    displayLabel: schemaPort.name,
    portId,
    handleId: toReactFlowHandleId(portId),
    sourceSchemaName: schemaPort.name,
    cardinalityKind: 'fixed',
    inference: 'authoritative',
    connectable: true,
    typeName: schemaPort.typeName,
    isOptional: schemaPort.isOptional,
    isSynchronous: schemaPort.isSynchronous,
    portKind: schemaPort.portKind,
    description: schemaPort.description,
  };
}

function collapsedDynamicRenderedPort(schemaPort: SchemaPort): RenderedPort {
  return {
    key: `${schemaPort.direction}:${schemaPort.name}:collapsed`,
    direction: schemaPort.direction,
    displayLabel: `${schemaPort.name}[*]`,
    portId: undefined,
    sourceSchemaName: schemaPort.name,
    cardinalityKind: 'dynamic',
    inference: 'collapsed',
    connectable: false,
    typeName: schemaPort.typeName,
    isOptional: schemaPort.isOptional,
    isSynchronous: schemaPort.isSynchronous,
    portKind: schemaPort.portKind,
    description: schemaPort.description,
  };
}

function expandedDynamicRenderedPorts(
  schemaPort: SchemaPort,
  count: number,
  inference: 'authoritative' | 'inferred',
  connectedPortIds: string[] = [],
): RenderedPort[] {
  const visibleCount = schemaPort.cardinalityKind === 'dynamic' ? Math.min(count, DEFAULT_DYNAMIC_PORT_UI_CAP) : count;
  const indices = new Set(Array.from({ length: visibleCount }, (_, index) => index));
  const [prefix, suffix = ''] = (schemaPort.handleNameTemplate ?? (`${schemaPort.name}#` + '${index}')).split('${index}');
  for (const id of connectedPortIds) {
    if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
    const raw = id.slice(prefix.length, suffix ? -suffix.length : undefined);
    const index = tryParseNonNegativeInteger(raw);
    if (index !== null && Number.isSafeInteger(index) && index < count && renderHandlePortId(schemaPort, index) === id) indices.add(index);
  }
  const ports: RenderedPort[] = [...indices].sort((a, b) => a - b).map((index) => ({
    semanticPortCount: count,
    key: `${schemaPort.direction}:${renderHandlePortId(schemaPort, index)}`,
    direction: schemaPort.direction,
    displayLabel: renderHandleName(schemaPort, index),
    portId: renderHandlePortId(schemaPort, index),
    handleId: toReactFlowHandleId(renderHandlePortId(schemaPort, index)),
    sourceSchemaName: schemaPort.name,
    cardinalityKind: 'dynamic',
    inference,
    connectable: true,
    typeName: schemaPort.typeName,
    isOptional: schemaPort.isOptional,
    isSynchronous: schemaPort.isSynchronous,
    portKind: schemaPort.portKind,
    description: schemaPort.description,
  }));
  if (indices.size < count) {
    ports.push({ ...collapsedDynamicRenderedPort(schemaPort), semanticPortCount: count,
      displayLabel: `${schemaPort.name} (${count - indices.size} more; ${count} ports)` });
  }
  return ports;
}

function resolveOne(schemaPort: SchemaPort, parameterValues: Record<string, string>, connectedPortIds: string[]): RenderedPort[] {
  if (schemaPort.schemaVersion === 1 && schemaPort.collectionKind === 'fixed') {
    const extent = normalizePortCount(schemaPort.fixedExtent);
    if (extent === null) return [collapsedDynamicRenderedPort(schemaPort)];
    return expandedDynamicRenderedPorts(schemaPort, extent, 'authoritative')
      .map((port) => ({ ...port, cardinalityKind: 'fixed', semanticPortCount: extent }));
  }
  if (schemaPort.cardinalityKind === 'fixed') {
    return [fixedRenderedPort(schemaPort)];
  }

  const count = explicitDynamicCount(schemaPort, parameterValues);
  return count === null
    ? [collapsedDynamicRenderedPort(schemaPort)]
    : expandedDynamicRenderedPorts(schemaPort, count, 'authoritative', connectedPortIds);
}

export function resolveRenderedPorts({
  schemaPorts,
  parameterValues,
  connectedPortIds = [],
}: ResolveRenderedPortsInput): ResolveRenderedPortsResult {
  const rendered = schemaPorts.flatMap((schemaPort) => resolveOne(schemaPort, parameterValues, connectedPortIds));

  return {
    inputs: rendered.filter((port) => port.direction === 'input'),
    outputs: rendered.filter((port) => port.direction === 'output'),
  };
}
