import { describe, expect, it } from 'vitest';

import {
  parseTwentyWebhookEvent,
  TwentyContractError,
  TwentyReadOnlyClient,
  type TwentyAuditMetadata,
} from './twenty-contract.js';

const audit: TwentyAuditMetadata = {
  channel: 'telegram',
  senderIdentity: 'telegram:approved-operator',
  agentGroup: 'telegram-operator-sandbox',
  approvalState: 'not_required',
  requestId: 'req_123',
};

describe('TwentyReadOnlyClient', () => {
  it('performs REST reads with bearer auth and audit headers', async () => {
    const requests: Request[] = [];
    const client = new TwentyReadOnlyClient({
      baseUrl: 'https://crm.kruh.club/',
      apiKey: 'test-token',
      audit,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(client.listRecords('companies', { limit: 1, fields: ['id', 'name'] })).resolves.toEqual({ data: [] });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://crm.kruh.club/rest/companies?limit=1&fields=id%2Cname');
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers.get('Authorization')).toBe('Bearer test-token');
    expect(requests[0].headers.get('X-Kruh-Channel')).toBe('telegram');
    expect(requests[0].headers.get('X-Kruh-Agent-Group')).toBe('telegram-operator-sandbox');
    expect(requests[0].headers.get('X-Kruh-Approval-State')).toBe('not_required');
    expect(requests[0].headers.get('X-Kruh-Request-Id')).toBe('req_123');
    expect(client.auditLog).toEqual([
      {
        method: 'GET',
        path: '/rest/companies?limit=1&fields=id%2Cname',
        audit,
        readonly: true,
      },
    ]);
  });

  it('rejects unsafe object names and out-of-range limits', async () => {
    const client = new TwentyReadOnlyClient({
      baseUrl: 'https://crm.kruh.club',
      apiKey: 'test-token',
      audit,
      fetchImpl: async () => new Response('{}'),
    });

    await expect(client.listRecords('../companies')).rejects.toThrow(TwentyContractError);
    await expect(client.listRecords('companies', { limit: 61 })).rejects.toThrow(TwentyContractError);
  });

  it('allows GraphQL queries but rejects mutations', async () => {
    const requests: Request[] = [];
    const client = new TwentyReadOnlyClient({
      baseUrl: 'https://crm.kruh.club',
      apiKey: 'test-token',
      audit,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ data: { companies: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(client.graphqlQuery('query ReadCompanies { companies { edges { node { id } } } }')).resolves.toEqual({
      data: { companies: [] },
    });
    await expect(client.graphqlQuery('mutation CreateCompany { createCompany(data: {}) { id } }')).rejects.toThrow(
      TwentyContractError,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://crm.kruh.club/graphql');
    expect(requests[0].method).toBe('POST');
    expect(await requests[0].json()).toEqual({
      query: 'query ReadCompanies { companies { edges { node { id } } } }',
    });
  });
});

describe('parseTwentyWebhookEvent', () => {
  it('normalizes Twenty webhook payloads while preserving audit metadata', () => {
    expect(
      parseTwentyWebhookEvent(
        {
          eventName: 'record.updated',
          data: {
            objectName: 'interaction',
            record: { id: 'record-123' },
          },
        },
        audit,
      ),
    ).toEqual({
      eventName: 'record.updated',
      objectName: 'interaction',
      recordId: 'record-123',
      raw: {
        eventName: 'record.updated',
        data: {
          objectName: 'interaction',
          record: { id: 'record-123' },
        },
      },
      audit,
    });
  });
});
