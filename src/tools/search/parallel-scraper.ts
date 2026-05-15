import axios from 'axios';
import type * as t from './types';
import { createDefaultLogger } from './utils';
import type { ParallelSessionRef } from './parallel-search';

const MAX_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT = 30000;

const normalizeUrlKey = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '';
    if (parsedUrl.pathname.length > 1) {
      parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');
    }
    return parsedUrl.toString();
  } catch {
    return url;
  }
};

const setUrlResult = (
  map: Map<string, t.ParallelExtractResult>,
  result: t.ParallelExtractResult
): void => {
  map.set(result.url, result);
  const normalizedUrl = normalizeUrlKey(result.url);
  if (!map.has(normalizedUrl)) {
    map.set(normalizedUrl, result);
  }
};

const chunkUrls = (urls: string[]): string[][] => {
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += MAX_BATCH_SIZE) {
    batches.push(urls.slice(index, index + MAX_BATCH_SIZE));
  }
  return batches;
};

export class ParallelScraper implements t.BaseScraper {
  private apiKey: string;
  private apiUrl: string;
  private timeout: number;
  private logger: t.Logger;
  private objective?: string;
  private searchQueries?: string[];
  private maxCharsTotal?: number;
  private clientModel?: string;
  private fullContent?: boolean;
  private sessionId?: string;
  private sessionIdRef?: ParallelSessionRef;
  private httpAgent?: t.HttpAgent;
  private httpsAgent?: t.HttpsAgent;

  constructor(
    config: t.ParallelScraperConfig = {},
    sessionIdRef?: ParallelSessionRef
  ) {
    this.apiKey = config.apiKey ?? process.env.PARALLEL_API_KEY ?? '';
    this.apiUrl =
      config.apiUrl ??
      process.env.PARALLEL_EXTRACT_URL ??
      'https://api.parallel.ai/v1/extract';
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.logger = config.logger || createDefaultLogger();
    this.objective = config.objective;
    this.searchQueries = config.searchQueries;
    this.maxCharsTotal = config.maxCharsTotal;
    this.clientModel = config.clientModel;
    this.fullContent = config.fullContent;
    this.sessionId = config.sessionId;
    this.sessionIdRef = sessionIdRef;
    this.httpAgent = config.httpAgent;
    this.httpsAgent = config.httpsAgent;

    if (!this.apiKey) {
      this.logger.warn('PARALLEL_API_KEY is not set. Scraping will not work.');
    }
  }

  async scrapeUrl(
    url: string,
    options: t.ParallelScrapeOptions = {}
  ): Promise<[string, t.ParallelScrapeResponse]> {
    const results = await this.scrapeUrls([url], options);
    return results[0];
  }

  async scrapeUrls(
    urls: string[],
    options: t.ParallelScrapeOptions = {}
  ): Promise<Array<[string, t.ParallelScrapeResponse]>> {
    if (!this.apiKey) {
      return urls.map((url) => [
        url,
        { success: false, error: 'PARALLEL_API_KEY is not set' },
      ]);
    }

    const batches = chunkUrls(urls);
    const allResults: Array<[string, t.ParallelScrapeResponse]> = [];
    for (const batch of batches) {
      const batchResults = await this.extractBatch(batch, options);
      allResults.push(...batchResults);
    }
    return allResults;
  }

  private async extractBatch(
    urls: string[],
    options: t.ParallelScrapeOptions = {}
  ): Promise<Array<[string, t.ParallelScrapeResponse]>> {
    try {
      const sessionId =
        options.sessionId ?? this.sessionIdRef?.current ?? this.sessionId;
      const payload = {
        urls,
        objective: options.objective ?? this.objective,
        search_queries: options.searchQueries ?? this.searchQueries,
        max_chars_total: options.maxCharsTotal ?? this.maxCharsTotal,
        session_id: sessionId,
        client_model: options.clientModel ?? this.clientModel,
        advanced_settings: {
          full_content: options.fullContent ?? this.fullContent,
        },
      };

      const response = await axios.post<t.ParallelExtractResponse>(
        this.apiUrl,
        payload,
        {
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          timeout: options.timeout ?? this.timeout,
          httpAgent: this.httpAgent,
          httpsAgent: this.httpsAgent,
        }
      );

      if (this.sessionIdRef) {
        this.sessionIdRef.current = response.data.session_id;
      }

      const successMap = new Map<string, t.ParallelExtractResult>();
      const failedMap = new Map<string, t.ParallelExtractError>();

      for (const result of response.data.results) {
        setUrlResult(successMap, result);
      }
      for (const error of response.data.errors) {
        failedMap.set(error.url, error);
        const normalizedUrl = normalizeUrlKey(error.url);
        if (!failedMap.has(normalizedUrl)) {
          failedMap.set(normalizedUrl, error);
        }
      }

      return urls.map((url): [string, t.ParallelScrapeResponse] => {
        const success =
          successMap.get(url) ?? successMap.get(normalizeUrlKey(url));
        if (success) {
          return [url, { success: true, data: success }];
        }

        const failure =
          failedMap.get(url) ?? failedMap.get(normalizeUrlKey(url));
        return [
          url,
          {
            success: false,
            error:
              failure?.content ?? 'URL not found in Parallel Extract response',
          },
        ];
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return urls.map((url) => [
        url,
        {
          success: false,
          error: `Parallel Extract API request failed: ${errorMessage}`,
        },
      ]);
    }
  }

  extractContent(
    response: t.ParallelScrapeResponse
  ): [string, undefined | t.References] {
    if (!response.success || !response.data) {
      return ['', undefined];
    }

    const data = response.data as t.ParallelExtractResult;
    const fullContent = data.full_content?.trim();
    const excerpts = Array.isArray(data.excerpts) ? data.excerpts : [];
    const content =
      typeof fullContent === 'string' && fullContent !== ''
        ? fullContent
        : excerpts.join('\n\n');

    return [content, undefined];
  }

  extractMetadata(response: t.ParallelScrapeResponse): t.GenericScrapeMetadata {
    if (!response.success || !response.data) {
      return {};
    }

    const data = response.data as t.ParallelExtractResult;
    return {
      url: data.url,
      sourceURL: data.url,
      title: data.title,
      excerpts_count: Array.isArray(data.excerpts) ? data.excerpts.length : 0,
    };
  }
}

export const createParallelScraper = (
  config: t.ParallelScraperConfig = {},
  sessionIdRef?: ParallelSessionRef
): ParallelScraper => {
  return new ParallelScraper(config, sessionIdRef);
};
