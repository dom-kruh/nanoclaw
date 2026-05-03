export type TwentyApprovalState = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface TwentyAuditMetadata {
  channel: string;
  senderIdentity: string;
  agentGroup: string;
  approvalState: TwentyApprovalState;
  requestId?: string;
}

export interface TwentyClientOptions {
  baseUrl: string;
  apiKey: string;
  audit: TwentyAuditMetadata;
  fetchImpl?: typeof fetch;
}

export interface TwentyListRecordsOptions {
  limit?: number;
  fields?: string[];
}

export interface TwentyRequestAuditEntry {
  method: 'GET' | 'POST';
  path: string;
  audit: TwentyAuditMetadata;
  readonly: true;
}

export interface TwentyWebhookEvent {
  eventName: string;
  objectName?: string;
  recordId?: string;
  raw: unknown;
  audit: TwentyAuditMetadata;
}

export class TwentyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwentyContractError';
  }
}

export class TwentyReadOnlyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly audit: TwentyAuditMetadata;
  private readonly fetchImpl: typeof fetch;
  private readonly requestAuditLog: TwentyRequestAuditEntry[] = [];

  constructor(options: TwentyClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = assertPresent(options.apiKey, 'apiKey');
    this.audit = validateAudit(options.audit);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get auditLog(): readonly TwentyRequestAuditEntry[] {
    return this.requestAuditLog;
  }

  async listRecords(objectPluralName: string, options: TwentyListRecordsOptions = {}): Promise<unknown> {
    const objectPath = sanitizeObjectPluralName(objectPluralName);
    const query = new URLSearchParams();
    const limit = options.limit ?? 20;

    if (!Number.isInteger(limit) || limit < 1 || limit > 60) {
      throw new TwentyContractError('limit must be an integer between 1 and 60');
    }

    query.set('limit', String(limit));

    if (options.fields?.length) {
      query.set('fields', options.fields.map(sanitizeFieldName).join(','));
    }

    const path = `/rest/${objectPath}?${query.toString()}`;

    return this.request('GET', path);
  }

  async graphqlQuery(query: string, variables?: Record<string, unknown>, operationName?: string): Promise<unknown> {
    if (!isReadOnlyGraphqlQuery(query)) {
      throw new TwentyContractError('Only GraphQL query operations are allowed by the Twenty read-only contract');
    }

    return this.request('POST', '/graphql', {
      query,
      variables,
      operationName,
    });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'X-Kruh-Channel': this.audit.channel,
      'X-Kruh-Agent-Group': this.audit.agentGroup,
      'X-Kruh-Approval-State': this.audit.approvalState,
    });

    if (this.audit.requestId) {
      headers.set('X-Kruh-Request-Id', this.audit.requestId);
    }

    let requestBody: string | undefined;
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    this.requestAuditLog.push({
      method,
      path,
      audit: this.audit,
      readonly: true,
    });

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: requestBody,
    });

    const text = await response.text();
    const payload = parseJsonOrText(text);

    if (!response.ok) {
      throw new TwentyContractError(`Twenty API ${method} ${path} failed with ${response.status}`);
    }

    return payload;
  }
}

export function parseTwentyWebhookEvent(raw: unknown, audit: TwentyAuditMetadata): TwentyWebhookEvent {
  const payload = asRecord(raw);
  const data = asRecord(payload.data);
  const record = asRecord(data.record);

  return {
    eventName: firstString(payload.event, payload.eventName, payload.type) ?? 'unknown',
    objectName: firstString(payload.objectName, data.objectName, data.object, payload.object),
    recordId: firstString(payload.recordId, data.recordId, record.id),
    raw,
    audit: validateAudit(audit),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = assertPresent(baseUrl, 'baseUrl').replace(/\/+$/, '');

  if (!/^https?:\/\//.test(value)) {
    throw new TwentyContractError('baseUrl must include http:// or https://');
  }

  return value;
}

function assertPresent(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TwentyContractError(`${label} is required`);
  }
  return trimmed;
}

function validateAudit(audit: TwentyAuditMetadata): TwentyAuditMetadata {
  if (!audit.channel || !audit.senderIdentity || !audit.agentGroup || !audit.approvalState) {
    throw new TwentyContractError('audit metadata must include channel, senderIdentity, agentGroup, and approvalState');
  }
  return audit;
}

function sanitizeObjectPluralName(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(trimmed)) {
    throw new TwentyContractError('object plural name must be an API name such as companies, orders, or interactions');
  }
  return trimmed;
}

function sanitizeFieldName(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(trimmed)) {
    throw new TwentyContractError('field name must be a Twenty API field path');
  }
  return trimmed;
}

function isReadOnlyGraphqlQuery(query: string): boolean {
  const withoutComments = query
    .split('\n')
    .map((line) => line.replace(/#.*/, ''))
    .join('\n')
    .trim();

  return /^(query\b|\{\s*)/i.test(withoutComments) && !/^\s*mutation\b/i.test(withoutComments);
}

function parseJsonOrText(text: string): unknown {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
