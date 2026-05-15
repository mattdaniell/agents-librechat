import axios from 'axios';
import type * as t from './types';
import { createDefaultLogger } from './utils';

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_CHARS_TOTAL = 50000;

export type ParallelSessionRef = {
  current?: string;
};

const getHostname = (link: string): string => {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
};

const clampMaxResults = (value: number): number =>
  Math.min(Math.max(1, Math.trunc(value)), 20);

const omitUndefined = <T extends Record<string, unknown>>(
  value: T
): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;

export const createParallelAPI = (
  apiKey?: string,
  apiUrl?: string,
  options: t.ParallelSearchOptions = {},
  sessionIdRef?: ParallelSessionRef
): {
  getSources: (params: t.GetSourcesParams) => Promise<t.SearchResult>;
} => {
  const config = {
    apiKey: apiKey ?? process.env.PARALLEL_API_KEY ?? '',
    apiUrl:
      apiUrl ??
      process.env.PARALLEL_SEARCH_URL ??
      'https://api.parallel.ai/v1/search',
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
  };

  if (!config.apiKey) {
    throw new Error('PARALLEL_API_KEY is required for Parallel API');
  }

  const getSources = async ({
    query,
    numResults = DEFAULT_MAX_RESULTS,
  }: t.GetSourcesParams): Promise<t.SearchResult> => {
    if (!query.trim()) {
      return { success: false, error: 'Query cannot be empty' };
    }

    const sessionId = options.sessionId ?? sessionIdRef?.current;
    const payload = omitUndefined({
      objective: query,
      search_queries: [query],
      mode: options.mode ?? 'advanced',
      max_results: clampMaxResults(options.maxResults ?? numResults),
      max_chars_total: options.maxCharsTotal ?? DEFAULT_MAX_CHARS_TOTAL,
      client_model: options.clientModel,
      session_id: sessionId,
      advanced_settings: omitUndefined({
        excerpts: omitUndefined({
          max_chars_per_result: options.maxCharsPerResult,
        }),
        source_policy: omitUndefined({
          include_domains: options.includeDomains,
          exclude_domains: options.excludeDomains,
        }),
      }),
    });

    try {
      const response = await axios.post<t.ParallelSearchResponse>(
        config.apiUrl,
        payload,
        {
          headers: {
            'x-api-key': config.apiKey,
            'Content-Type': 'application/json',
          },
          timeout: config.timeout,
          httpAgent: options.httpAgent,
          httpsAgent: options.httpsAgent,
        }
      );

      if (sessionIdRef) {
        sessionIdRef.current = response.data.session_id;
      }

      const organic = response.data.results
        .filter((result) => typeof result.url === 'string' && result.url !== '')
        .map(
          (result, index): t.OrganicResult => ({
            position: index + 1,
            title: result.title ?? '',
            link: result.url ?? '',
            snippet: Array.isArray(result.excerpts)
              ? result.excerpts.join('\n\n')
              : '',
            date: result.publish_date ?? '',
            sitelinks: undefined,
          })
        )
        .map((result) => ({
          ...result,
          attribution: getHostname(result.link),
        })) as t.ProcessedOrganic[];

      return {
        success: true,
        data: {
          organic,
          topStories: [],
          images: [],
          videos: [],
          news: [],
          places: [],
          shopping: [],
          peopleAlsoAsk: [],
          relatedSearches: [],
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Parallel Search API request failed: ${errorMessage}`,
      };
    }
  };

  return { getSources };
};

export const createDefaultParallelLogger = createDefaultLogger;
