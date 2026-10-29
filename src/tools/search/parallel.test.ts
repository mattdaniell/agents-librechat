import axios from 'axios';
import { Agent as HttpsAgent } from 'https';
import type * as t from './types';
import {
  createParallelAPI,
  toParallelLocation,
  toParallelAfterDate,
} from './parallel-search';
import { createParallelScraper } from './parallel-scraper';
import { createSearchTool } from './tool';
import { DATE_RANGE } from './schema';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
} as unknown as t.Logger;

describe('Parallel search API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws when the Parallel API key is missing', () => {
    expect(() => createParallelAPI('', undefined, {}, undefined)).toThrow(
      'PARALLEL_API_KEY is required for Parallel API'
    );
  });

  it('returns an error for empty search queries', async () => {
    const searchAPI = createParallelAPI('test-key');

    const result = await searchAPI.getSources({ query: '   ' });

    expect(result).toEqual({
      success: false,
      error: 'Query cannot be empty',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('maps search results and preserves session ids', async () => {
    const sessionRef = { current: undefined as string | undefined };
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        search_id: 'search_1',
        session_id: 'session_1',
        results: [
          {
            url: 'https://example.com/article',
            title: 'Example article',
            publish_date: '2026-01-02',
            excerpts: ['First excerpt', 'Second excerpt'],
          },
        ],
      },
    });

    const searchAPI = createParallelAPI(
      'test-key',
      'https://api.parallel.ai/v1/search',
      {
        mode: 'basic',
        maxResults: 4,
        maxCharsTotal: 9000,
        maxCharsPerResult: 120,
        includeDomains: ['example.com'],
        excludeDomains: ['blocked.example.com'],
        clientModel: 'claude',
      },
      sessionRef
    );

    const result = await searchAPI.getSources({ query: 'example query' });
    const [, payload] = mockedAxios.post.mock.calls[0];

    expect(payload).toMatchObject({
      objective: 'example query',
      search_queries: ['example query'],
      mode: 'basic',
      max_chars_total: 9000,
      client_model: 'claude',
      advanced_settings: {
        max_results: 4,
        excerpt_settings: {
          max_chars_per_result: 120,
        },
        source_policy: {
          include_domains: ['example.com'],
          exclude_domains: ['blocked.example.com'],
        },
      },
    });
    expect(payload).not.toHaveProperty('session_id');
    expect(sessionRef.current).toBe('session_1');
    expect(result.data?.organic?.[0]).toMatchObject({
      title: 'Example article',
      link: 'https://example.com/article',
      snippet: 'First excerpt\n\nSecond excerpt',
      date: '2026-01-02',
      attribution: 'example.com',
    });
  });

  it('defaults to fast mode and maps the date range and country', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-29T12:00:00Z'));
    mockedAxios.post.mockResolvedValueOnce({
      data: { search_id: 'search_1', session_id: 'session_1', results: [] },
    });

    try {
      await createParallelAPI('test-key').getSources({
        query: 'example query',
        date: DATE_RANGE.PAST_WEEK,
        country: 'UK',
      });
    } finally {
      jest.useRealTimers();
    }

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      mode: 'fast',
      advanced_settings: {
        location: 'gb',
        source_policy: { after_date: '2026-10-22' },
      },
    });
    expect(mockedAxios.post.mock.calls[0][1]).not.toHaveProperty(
      'max_chars_total'
    );
  });

  it('omits filters the request did not ask for or Parallel cannot read', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { search_id: 'search_1', session_id: 'session_1', results: [] },
    });

    await createParallelAPI('test-key').getSources({
      query: 'example query',
      country: 'United States',
    });

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect(payload).not.toHaveProperty('advanced_settings.location');
    expect(payload).not.toHaveProperty(
      'advanced_settings.source_policy.after_date'
    );
  });

  it('converts every date range to a publish-date floor', () => {
    const now = new Date('2026-10-29T00:30:00Z');
    expect(toParallelAfterDate(DATE_RANGE.PAST_HOUR, now)).toBe('2026-10-29');
    expect(toParallelAfterDate(DATE_RANGE.PAST_24_HOURS, now)).toBe(
      '2026-10-28'
    );
    expect(toParallelAfterDate(DATE_RANGE.PAST_MONTH, now)).toBe('2026-09-28');
    expect(toParallelAfterDate(DATE_RANGE.PAST_YEAR, now)).toBe('2025-10-28');
    expect(toParallelAfterDate(undefined, now)).toBeUndefined();
  });

  it('accepts two-letter country codes only', () => {
    expect(toParallelLocation(' DE ')).toBe('de');
    expect(toParallelLocation('uk')).toBe('gb');
    expect(toParallelLocation('usa')).toBeUndefined();
    expect(toParallelLocation('')).toBeUndefined();
  });

  it('searches images on the image endpoint beside the search URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        search_id: 'search_1',
        results: [
          {
            title: 'Launch pad',
            image_url: 'https://images.example.com/pad.jpg',
            source_page_url: 'https://www.example.com/story',
            width: 1200,
            height: 800,
          },
          { title: 'No image', image_url: '' },
        ],
      },
    });

    const result = await createParallelAPI(
      'test-key',
      'https://proxy.example.com/parallel/v1/search'
    ).getSources({ query: 'launch pad', type: 'images', country: 'us' });

    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      'https://proxy.example.com/parallel/v1/images/search'
    );
    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      objective: 'launch pad',
      search_queries: ['launch pad'],
      advanced_settings: { location: 'us' },
    });
    expect(result).toMatchObject({ success: true });
    expect(result.data?.organic).toEqual([]);
    expect(result.data?.images).toEqual([
      {
        position: 1,
        title: 'Launch pad',
        imageUrl: 'https://images.example.com/pad.jpg',
        imageWidth: 1200,
        imageHeight: 800,
        link: 'https://www.example.com/story',
        domain: 'example.com',
      },
    ]);
  });

  it('skips image search when a custom URL does not end in /search', async () => {
    const result = await createParallelAPI(
      'test-key',
      'https://gateway.example.com/parallel'
    ).getSources({ query: 'launch pad', type: 'images' });

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: { organic: [], images: [] },
    });
  });
});

describe('ParallelScraper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('batches urls and extracts content from full content or excerpts', async () => {
    const sessionRef = { current: 'session_1' };
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        extract_id: 'extract_1',
        session_id: 'session_2',
        results: [
          {
            url: 'https://example.com/article',
            title: 'Example article',
            excerpts: ['A shorter excerpt'],
            full_content: 'The full article content',
          },
        ],
        errors: [],
      },
    });

    const scraper = createParallelScraper(
      {
        apiKey: 'test-key',
        apiUrl: 'https://api.parallel.ai/v1/extract',
        objective: 'Summarize this page',
        searchQueries: ['example query'],
        maxCharsTotal: 1234,
        clientModel: 'claude',
        fullContent: true,
      },
      sessionRef
    );

    const results = await scraper.scrapeUrls(['https://example.com/article'], {
      timeout: 5000,
    });
    const [, payload] = mockedAxios.post.mock.calls[0];

    expect(payload).toMatchObject({
      urls: ['https://example.com/article'],
      objective: 'Summarize this page',
      search_queries: ['example query'],
      max_chars_total: 1234,
      client_model: 'claude',
      session_id: 'session_1',
      advanced_settings: {
        full_content: true,
      },
    });
    expect(sessionRef.current).toBe('session_2');
    expect(results[0][1]).toMatchObject({
      success: true,
    });
    expect(scraper.extractContent(results[0][1])[0]).toBe(
      'The full article content'
    );
    expect(scraper.extractMetadata(results[0][1])).toMatchObject({
      url: 'https://example.com/article',
      sourceURL: 'https://example.com/article',
      excerpts_count: 1,
    });
  });
});

describe('Parallel search tool integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses the Parallel session id between search and extract', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          search_id: 'search_1',
          session_id: 'session_1',
          results: [
            {
              url: 'https://example.com/article',
              title: 'Example article',
              publish_date: '2026-01-02',
              excerpts: ['Search excerpt'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          extract_id: 'extract_1',
          session_id: 'session_1',
          results: [
            {
              url: 'https://example.com/article',
              title: 'Example article',
              excerpts: ['Extracted content'],
              full_content: 'Extracted content',
            },
          ],
          errors: [],
        },
      });

    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      parallelSearchOptions: {
        mode: 'advanced',
      },
      parallelScraperOptions: {
        fullContent: true,
      },
      rerankerType: 'none',
      logger: mockLogger,
    });

    await searchTool.invoke({
      query: 'example query',
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({
      session_id: 'session_1',
      objective: 'example query',
      search_queries: ['example query'],
    });
  });

  it('adds Parallel image results and skips video and news searches', async () => {
    const imageResponse = {
      search_id: 'search_2',
      results: [
        {
          title: 'Pad',
          image_url: 'https://images.example.com/pad.jpg',
          source_page_url: 'https://example.com/story',
        },
      ],
    };
    const webResponse = {
      search_id: 'search_1',
      session_id: 'session_1',
      results: [],
    };
    mockedAxios.post.mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith('/images/search') ? imageResponse : webResponse,
      })
    );
    const onSearchResults = jest.fn();

    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'none',
      onSearchResults,
      logger: mockLogger,
    });

    await searchTool.invoke({
      query: 'example query',
      images: true,
      videos: true,
      news: true,
    });

    expect(mockedAxios.post.mock.calls.map(([url]) => url).sort()).toEqual([
      'https://api.parallel.ai/v1/images/search',
      'https://api.parallel.ai/v1/search',
    ]);
    expect(onSearchResults.mock.calls[0][0].data.images).toEqual([
      expect.objectContaining({
        title: 'Pad',
        imageUrl: 'https://images.example.com/pad.jpg',
      }),
    ]);
  });

  it('labels extracted sources by domain rather than page title', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          search_id: 'search_1',
          session_id: 'session_1',
          results: [
            {
              url: 'https://www.example.com/a',
              title: 'Long page title',
              excerpts: ['a'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          extract_id: 'extract_1',
          session_id: 'session_1',
          results: [
            {
              url: 'https://www.example.com/a',
              title: 'A very long article title | Example News',
              excerpts: ['Extracted content about the query'],
            },
          ],
          errors: [],
        },
      });

    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'none',
      logger: mockLogger,
    });

    const output = await searchTool.invoke({ query: 'example query' });
    const text = typeof output === 'string' ? output : JSON.stringify(output);

    expect(text).not.toContain('Example News');
    expect(text).toContain('example.com');
  });

  const first =
    'Two-phase borrows are a more permissive version of mutable borrows.';
  const second =
    'At every location in the MIR the checker tests whether a reservation is activated.';
  const mockSearchThenExtract = (): void => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url.endsWith('/v1/search')) {
        return Promise.resolve({
          data: {
            search_id: 'search_1',
            session_id: 'session_1',
            results: [
              {
                url: 'https://example.com/a',
                title: 'A',
                excerpts: ['summary'],
              },
            ],
          },
        });
      }
      if (url.endsWith('/v1/extract')) {
        return Promise.resolve({
          data: {
            extract_id: 'extract_1',
            session_id: 'session_1',
            results: [
              { url: 'https://example.com/a', excerpts: [first, second] },
            ],
            errors: [],
          },
        });
      }
      return Promise.resolve({
        data: { model: 'jina', usage: { total_tokens: 1 }, results: [] },
      });
    });
  };

  it('uses Parallel excerpts as the highlights when no reranker is set', async () => {
    mockSearchThenExtract();
    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'none',
      logger: mockLogger,
    });

    const output = await searchTool.invoke({ query: 'two-phase borrows' });
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    const blocks = text.split('### Highlight').slice(1);

    expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({
      advanced_settings: { excerpt_settings: { max_chars_per_result: 3500 } },
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain(first);
    expect(blocks[0]).not.toContain(second);
    expect(blocks[1]).toContain(second);
    expect(text.split(first)).toHaveLength(2);
  });

  it('leaves a configured reranker to pick from the full extracted text', async () => {
    mockSearchThenExtract();
    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'jina',
      jinaApiKey: 'jina-key',
      logger: mockLogger,
    });

    await searchTool.invoke({ query: 'two-phase borrows' });

    const urls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(urls).toContain('https://api.jina.ai/v1/rerank');
    expect(mockedAxios.post.mock.calls[1][1]).not.toHaveProperty(
      'advanced_settings.excerpt_settings'
    );
  });

  it('lets the excerpt budget per page be configured', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        extract_id: 'extract_1',
        session_id: 's',
        results: [],
        errors: [],
      },
    });

    await createParallelScraper({
      apiKey: 'test-key',
      maxCharsPerResult: 8000,
    }).scrapeUrls(['https://example.com/a']);

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      advanced_settings: { excerpt_settings: { max_chars_per_result: 8000 } },
    });
  });

  it('forwards the shared https agent to search and extract requests', async () => {
    const httpsAgent = new HttpsAgent();
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          search_id: 'search_1',
          session_id: 'session_1',
          results: [{ url: 'https://example.com/a', excerpts: ['a'] }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          extract_id: 'extract_1',
          session_id: 'session_1',
          results: [{ url: 'https://example.com/a', excerpts: ['a'] }],
          errors: [],
        },
      });

    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'none',
      httpsAgent,
      logger: mockLogger,
    });

    await searchTool.invoke({ query: 'example query' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls[0][2]).toMatchObject({ httpsAgent });
    expect(mockedAxios.post.mock.calls[1][2]).toMatchObject({ httpsAgent });
  });
});
