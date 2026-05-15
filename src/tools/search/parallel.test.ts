import axios from 'axios';
import { Agent as HttpsAgent } from 'https';
import type * as t from './types';
import { createParallelScraper } from './parallel-scraper';
import { createParallelAPI } from './parallel-search';
import { createSearchTool } from './tool';

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
      max_results: 4,
      client_model: 'claude',
      advanced_settings: {
        excerpts: {
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
      title: 'Example article',
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

  it('sends only the organic query when images and news are requested', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { search_id: 'search_1', session_id: 'session_1', results: [] },
    });

    const searchTool = createSearchTool({
      searchProvider: 'parallel',
      parallelApiKey: 'test-key',
      scraperProvider: 'parallel',
      rerankerType: 'none',
      logger: mockLogger,
    });

    await searchTool.invoke({
      query: 'example query',
      images: true,
      videos: true,
      news: true,
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      'https://api.parallel.ai/v1/search'
    );
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
