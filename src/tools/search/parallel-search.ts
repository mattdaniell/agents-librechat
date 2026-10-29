import axios from 'axios';
import type * as t from './types';
import { createDefaultLogger } from './utils';
import { DATE_RANGE } from './schema';

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_SEARCH_URL = 'https://api.parallel.ai/v1/search';
/** Parallel recommends `fast` for interactive agents: sub-second and the
 * lowest-priced tier, where the API's own default (`advanced`) is ~3s. */
const DEFAULT_MODE: t.ParallelSearchMode = 'fast';

const DAYS_BY_DATE_RANGE: Record<DATE_RANGE, number> = {
  [DATE_RANGE.PAST_HOUR]: 0,
  [DATE_RANGE.PAST_24_HOURS]: 1,
  [DATE_RANGE.PAST_WEEK]: 7,
  [DATE_RANGE.PAST_MONTH]: 31,
  [DATE_RANGE.PAST_YEAR]: 366,
};

/** The tool schema suggests `uk`; ISO 3166-1 alpha-2, which Parallel takes, is `gb`. */
const COUNTRY_ALIASES: Record<string, string> = { uk: 'gb' };

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

/** Parallel filters by publish date at day granularity, so a past-hour range
 * becomes today. */
export const toParallelAfterDate = (
  date?: DATE_RANGE,
  now: Date = new Date()
): string | undefined => {
  const days = date != null ? DAYS_BY_DATE_RANGE[date] : undefined;
  if (days == null) {
    return undefined;
  }
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
};

export const toParallelLocation = (country?: string): string | undefined => {
  const code = country?.trim().toLowerCase();
  if (code == null || !/^[a-z]{2}$/.test(code)) {
    return undefined;
  }
  return COUNTRY_ALIASES[code] ?? code;
};

/** Image search lives beside web search on the same host, so a custom search
 * URL that keeps Parallel's path shape (a proxy) carries image requests too.
 * Any other shape gets no image search rather than a guessed destination. */
const toImagesUrl = (searchUrl: string): string | undefined =>
  /\/search\/?$/.test(searchUrl)
    ? searchUrl.replace(/\/search\/?$/, '/images/search')
    : undefined;

const toImageResults = (results: t.ParallelImageResult[]): t.ImageResult[] =>
  results
    .filter(
      (result) =>
        typeof result.image_url === 'string' && result.image_url !== ''
    )
    .map((result, index) => ({
      position: index + 1,
      title: result.title ?? undefined,
      imageUrl: result.image_url,
      imageWidth: result.width ?? undefined,
      imageHeight: result.height ?? undefined,
      link: result.source_page_url ?? undefined,
      domain:
        result.source_page_url != null
          ? getHostname(result.source_page_url)
          : undefined,
    }));

const emptyVerticals = (): Omit<t.SearchResultData, 'organic' | 'images'> => ({
  topStories: [],
  videos: [],
  news: [],
  places: [],
  shopping: [],
  peopleAlsoAsk: [],
  relatedSearches: [],
});

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
    apiUrl: apiUrl ?? process.env.PARALLEL_SEARCH_URL ?? DEFAULT_SEARCH_URL,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
  };
  const imagesUrl = toImagesUrl(config.apiUrl);
  const requestConfig = {
    headers: {
      'x-api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: config.timeout,
    httpAgent: options.httpAgent,
    httpsAgent: options.httpsAgent,
  };

  if (!config.apiKey) {
    throw new Error('PARALLEL_API_KEY is required for Parallel API');
  }

  const searchImages = async (
    query: string,
    location: string | undefined,
    numResults: number
  ): Promise<t.SearchResult> => {
    if (imagesUrl == null) {
      return { success: true, data: { organic: [], images: [] } };
    }
    try {
      const response = await axios.post<t.ParallelImageSearchResponse>(
        imagesUrl,
        omitUndefined({
          objective: query,
          search_queries: [query],
          mode: 'fast',
          client_model: options.clientModel,
          advanced_settings: omitUndefined({
            max_results: clampMaxResults(numResults),
            location,
          }),
        }),
        requestConfig
      );
      return {
        success: true,
        data: {
          ...emptyVerticals(),
          organic: [],
          images: toImageResults(response.data.results),
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Parallel Image Search API request failed: ${errorMessage}`,
      };
    }
  };

  const getSources = async ({
    query,
    date,
    country,
    type,
    numResults = DEFAULT_MAX_RESULTS,
  }: t.GetSourcesParams): Promise<t.SearchResult> => {
    if (!query.trim()) {
      return { success: false, error: 'Query cannot be empty' };
    }

    const location = toParallelLocation(country);
    if (type === 'images') {
      return searchImages(query, location, options.maxResults ?? numResults);
    }

    const sessionId = options.sessionId ?? sessionIdRef?.current;
    const payload = omitUndefined({
      objective: query,
      search_queries: [query],
      mode: options.mode ?? DEFAULT_MODE,
      /** Unset by default: Parallel sizes the excerpts to the query, which
       * runs several times smaller than a fixed 50k budget. */
      max_chars_total: options.maxCharsTotal,
      client_model: options.clientModel,
      session_id: sessionId,
      advanced_settings: omitUndefined({
        max_results: clampMaxResults(options.maxResults ?? numResults),
        location,
        excerpt_settings: omitUndefined({
          max_chars_per_result: options.maxCharsPerResult,
        }),
        source_policy: omitUndefined({
          include_domains: options.includeDomains,
          exclude_domains: options.excludeDomains,
          after_date: toParallelAfterDate(date),
        }),
      }),
    });

    try {
      const response = await axios.post<t.ParallelSearchResponse>(
        config.apiUrl,
        payload,
        requestConfig
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
        data: { ...emptyVerticals(), organic, images: [] },
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
