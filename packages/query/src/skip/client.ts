/**
 * skip go api client
 * minimal implementation for ibc routing between cosmos chains
 */

import type {
  RouteRequest,
  RouteResponse,
  MessagesRequest,
  MessagesResponse,
  TransactionStatusRequest,
  TransactionStatusResponse,
  SubmitTransactionRequest,
  SubmitTransactionResponse,
  TrackTransactionRequest,
  TrackTransactionResponse,
  SkipChain,
  SkipAsset,
} from './types';

const DEFAULT_API_URL = 'https://api.skip.build';

/** convert camelCase to snake_case */
const toSnake = (obj: unknown): unknown => {
  if (Array.isArray(obj)) {
    return obj.map(toSnake);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).reduce(
      (acc, [key, value]) => {
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        acc[snakeKey] = toSnake(value);
        return acc;
      },
      {} as Record<string, unknown>
    );
  }
  return obj;
};

/** convert snake_case to camelCase */
const toCamel = (obj: unknown): unknown => {
  if (Array.isArray(obj)) {
    return obj.map(toCamel);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).reduce(
      (acc, [key, value]) => {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        acc[camelKey] = toCamel(value);
        return acc;
      },
      {} as Record<string, unknown>
    );
  }
  return obj;
};

export interface SkipClientOptions {
  apiUrl?: string;
  apiKey?: string;
  affiliateFeeBps?: string;
}

export class SkipClient {
  private readonly apiUrl: string;
  private readonly headers: Headers;
  private readonly affiliateFeeBps: string;

  constructor(options: SkipClientOptions = {}) {
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.affiliateFeeBps = options.affiliateFeeBps ?? '0';

    this.headers = new Headers({
      'content-type': 'application/json',
    });

    if (options.apiKey) {
      this.headers.set('authorization', options.apiKey);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.apiUrl}/${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(toSnake(body)),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.message ?? `skip api error: ${response.status}`);
    }

    const data = await response.json();
    return toCamel(data) as T;
  }

  private async get<T>(path: string, params?: Record<string, string | string[]>): Promise<T> {
    const url = new URL(`${this.apiUrl}/${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (Array.isArray(value)) {
          value.forEach(v => url.searchParams.append(snakeKey, v));
        } else if (value !== undefined) {
          url.searchParams.set(snakeKey, value);
        }
      });
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.message ?? `skip api error: ${response.status}`);
    }

    const data = await response.json();
    return toCamel(data) as T;
  }

  /** get available chains */
  async chains(options?: {
    includeEvm?: boolean;
    includeSvm?: boolean;
    includeTestnets?: boolean;
  }): Promise<SkipChain[]> {
    const response = await this.get<{ chains: SkipChain[] }>('v2/info/chains', {
      includeEvm: String(options?.includeEvm ?? false),
      includeSvm: String(options?.includeSvm ?? false),
      includeTestnets: String(options?.includeTestnets ?? false),
    });
    return response.chains;
  }

  /** get assets for a chain */
  async assets(chainId: string): Promise<SkipAsset[]> {
    const response = await this.get<{ chainToAssetsMap: Record<string, { assets: SkipAsset[] }> }>(
      'v2/fungible/assets',
      { chainId }
    );
    return response.chainToAssetsMap[chainId]?.assets ?? [];
  }

  /** find route between source and destination */
  async route(request: RouteRequest): Promise<RouteResponse> {
    return this.post<RouteResponse>('v2/fungible/route', {
      ...request,
      cumulativeAffiliateFeeBps: this.affiliateFeeBps,
    });
  }

  /** get transaction messages for a route */
  async messages(request: MessagesRequest): Promise<MessagesResponse> {
    return this.post<MessagesResponse>('v2/fungible/msgs', request);
  }

  /** get transaction status */
  async transactionStatus(request: TransactionStatusRequest): Promise<TransactionStatusResponse> {
    return this.get<TransactionStatusResponse>('v2/tx/status', {
      chainId: request.chainId,
      txHash: request.txHash,
    });
  }

  /** submit signed transaction */
  async submitTransaction(request: SubmitTransactionRequest): Promise<SubmitTransactionResponse> {
    return this.post<SubmitTransactionResponse>('v2/tx/submit', request);
  }

  /** track transaction for status updates */
  async trackTransaction(request: TrackTransactionRequest): Promise<TrackTransactionResponse> {
    return this.post<TrackTransactionResponse>('v2/tx/track', request);
  }

  /**
   * poll for transaction completion
   * returns when status is completed or fails after max retries
   */
  async waitForTransaction(
    request: TransactionStatusRequest,
    options?: {
      maxRetries?: number;
      intervalMs?: number;
      onStatus?: (status: TransactionStatusResponse) => void;
    }
  ): Promise<TransactionStatusResponse> {
    const maxRetries = options?.maxRetries ?? 60;
    const intervalMs = options?.intervalMs ?? 2000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const status = await this.transactionStatus(request);
      options?.onStatus?.(status);

      if (
        status.state === 'STATE_COMPLETED_SUCCESS' ||
        status.state === 'STATE_COMPLETED_ERROR' ||
        status.state === 'STATE_ABANDONED'
      ) {
        return status;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error('transaction status polling timed out');
  }
}

/** singleton instance with default options */
let defaultClient: SkipClient | undefined;

export const getSkipClient = (options?: SkipClientOptions): SkipClient => {
  if (!defaultClient) {
    defaultClient = new SkipClient(options);
  }
  return defaultClient;
};

/** reset default client (useful for testing) */
export const resetSkipClient = (): void => {
  defaultClient = undefined;
};
